import assert from "node:assert/strict";
import test from "node:test";

import {
  capControllerEvidence,
  capReplayedControllerEvidence,
} from "../../src/core/controller-evidence.js";
import { observationFor } from "../../src/core/controller-turn.js";
import { commandHash } from "../../src/core/ids.js";
import { initialRunState } from "../../src/core/state-machine.js";
import type { JobObservation } from "../../src/protocol/types.js";

const fixtures = [
  { name: "Traditional Chinese", value: "繁體中文證據", units: 6 },
  { name: "non-BMP characters", value: "甲😀𠮷乙", units: 6 },
  { name: "combining characters", value: "甲e\u0301o\u0308乙", units: 6 },
  { name: "mixed newlines", value: "甲\r\n乙\n丙\r丁", units: 8 },
];

for (const { name, value, units } of fixtures) {
  test(`${name}: cap boundaries and repeated replay use UTF-16 code units`, () => {
    assert.equal(value.length, units);
    // Include cuts inside surrogate pairs, combining sequences, and CRLF,
    // as well as immediately below, at, and above the source length.
    for (let maximum = 1; maximum <= units + 1; maximum += 1) {
      const omitted = Math.max(0, units - maximum);
      const expectedValue = omitted === 0
        ? value
        : `${value.slice(0, maximum)}\n...[job evidence capped: ${omitted} chars omitted; total_chars=${units}; cap=${maximum}]`;
      const expected = {
        value: expectedValue,
        totalChars: units,
        truncatedChars: omitted,
      };
      const capped = capControllerEvidence(value, maximum);
      assert.deepEqual(capped, expected, `cap=${maximum}`);
      let replayed = capped;
      for (let replay = 0; replay < 3; replay += 1) {
        replayed = capReplayedControllerEvidence(replayed.value, units, maximum);
        assert.deepEqual(replayed, expected, `cap=${maximum}, replay=${replay}`);
        assert.equal(
          replayed.value.split("...[job evidence capped:").length - 1,
          omitted === 0 ? 0 : 1,
        );
        assert.equal(
          commandHash({ field: "output", value: replayed.value }),
          commandHash({ field: "output", value: expectedValue }),
        );
      }
    }
  });
}

test("mixed Unicode pagination reconstructs only servable evidence across replay", () => {
  const source = `${"繁中😀𠮷e\u0301\r\n甲\n乙\r".repeat(4_000)}DISCARDED_TAIL`;
  const capped = capControllerEvidence(source, 20_000);
  const replayed = capReplayedControllerEvidence(capped.value, source.length, 20_000);
  assert.deepEqual(replayed, capped);
  const state = initialRunState("run_unicode_pages", "Inspect Unicode evidence", "caller");
  const job: JobObservation = {
    job_id: "job_unicode_pages",
    job_key: "unicode_evidence",
    required: true,
    status: "succeeded",
    output: capped.value,
    output_total_chars: source.length,
  };
  const expectedHash = commandHash({ field: "output", value: capped.value });
  let offset = 0;
  let reconstructed = "";
  let pages = 0;
  for (; pages < 20; pages += 1) {
    const observed = observationFor(state, pages + 2, `msg_unicode_${pages}`, [job]).jobs[0]!;
    const window = observed.evidence_window!;
    assert.equal(observed.output_total_chars, source.length);
    assert.equal(window.offset, offset);
    assert.equal(window.total_chars, capped.value.length);
    assert.equal(window.content_hash, expectedHash);
    assert.ok(window.end > offset);
    assert.ok(window.end <= capped.value.length);
    const payload = capped.value.slice(offset, window.end);
    const remaining = capped.value.length - window.end;
    assert.equal(
      observed.output,
      remaining === 0 ? payload : `${payload}\n...[truncated ${remaining} chars]`,
    );
    reconstructed += payload;
    if (window.next_offset === null) {
      assert.equal(window.end, capped.value.length);
      break;
    }
    assert.equal(window.next_offset, window.end);
    offset = window.next_offset;
    state.inspectionJobIds = [job.job_id];
    state.inspectionEvidenceOffset = offset;
    state.inspectionEvidenceHash = window.content_hash;
    // Resume the next page from the durable replay representation.
    job.output = replayed.value;
  }
  assert.ok(pages > 0 && pages < 20, "pagination must advance and terminate");
  assert.equal(reconstructed, capped.value);
  assert.doesNotMatch(reconstructed, /DISCARDED_TAIL/);

  state.inspectionJobIds = [job.job_id];
  state.inspectionEvidenceHash = expectedHash;
  for (const requestedOffset of [capped.value.length, capped.value.length + 1, source.length]) {
    state.inspectionEvidenceOffset = requestedOffset;
    const observed = observationFor(state, 30, "msg_unicode_end", [job]).jobs[0]!;
    const window = observed.evidence_window!;
    assert.equal(window.offset, capped.value.length);
    assert.equal(window.end, capped.value.length);
    assert.equal(window.total_chars, capped.value.length);
    assert.equal(window.next_offset, null);
    assert.equal(window.content_hash, expectedHash);
    assert.equal(observed.output, "");
  }
});
