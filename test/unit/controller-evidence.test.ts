import assert from "node:assert/strict";
import test from "node:test";

import {
  capControllerEvidence,
  capReplayedControllerEvidence,
  controllerEvidenceCapacityNotice,
} from "../../src/core/controller-evidence.js";
import { validateControllerRuntimeOptions } from "../../src/core/controller-loop.js";
import { CueLineError } from "../../src/core/errors.js";
import { commandHash } from "../../src/core/ids.js";
import { observationFor } from "../../src/core/controller-turn.js";
import { initialRunState } from "../../src/core/state-machine.js";
import type { JobObservation } from "../../src/protocol/types.js";

test("replayed evidence preserves an exactly matching trailing cap marker", () => {
  const value = "HEAD\n...[job evidence capped: 4 chars omitted; total_chars=8; cap=4]";

  assert.deepEqual(capControllerEvidence("HEADTAIL", 4), {
    value,
    totalChars: 8,
    truncatedChars: 4,
  });
  assert.deepEqual(capReplayedControllerEvidence(value, 8, 4), {
    value,
    totalChars: 8,
    truncatedChars: 4,
  });
});

const replayMarker = "\n...[job evidence capped: 4 chars omitted; total_chars=8; cap=4]";
const invalidReplays: Array<{
  reason: string;
  value: string;
  declaredTotalChars: number | undefined;
}> = [
  { reason: "marker starts before the cap", value: `ABC${replayMarker}`, declaredTotalChars: 8 },
  { reason: "marker starts after the cap", value: `ABCDE${replayMarker}`, declaredTotalChars: 8 },
  {
    reason: "marker cap differs from the run cap",
    value: "HEAD\n...[job evidence capped: 4 chars omitted; total_chars=8; cap=5]",
    declaredTotalChars: 8,
  },
  { reason: "declared total is undefined", value: `HEAD${replayMarker}`, declaredTotalChars: undefined },
  { reason: "declared total is fractional", value: `HEAD${replayMarker}`, declaredTotalChars: 8.5 },
  {
    reason: "declared total is not a safe integer",
    value: "HEAD\n...[job evidence capped: 9007199254740988 chars omitted; total_chars=9007199254740992; cap=4]",
    declaredTotalChars: Number.MAX_SAFE_INTEGER + 1,
  },
  { reason: "declared total differs from marker total", value: `HEAD${replayMarker}`, declaredTotalChars: 9 },
  {
    reason: "omitted count is not a safe integer",
    value: "HEAD\n...[job evidence capped: 9007199254740992 chars omitted; total_chars=8; cap=4]",
    declaredTotalChars: 8,
  },
  {
    reason: "omitted count differs from total minus cap",
    value: "HEAD\n...[job evidence capped: 3 chars omitted; total_chars=8; cap=4]",
    declaredTotalChars: 8,
  },
  {
    reason: "omitted count is zero",
    value: "HEAD\n...[job evidence capped: 0 chars omitted; total_chars=4; cap=4]",
    declaredTotalChars: 4,
  },
  {
    reason: "omitted count is negative",
    value: "HEAD\n...[job evidence capped: -1 chars omitted; total_chars=3; cap=4]",
    declaredTotalChars: 3,
  },
  { reason: "text follows the marker", value: `HEAD${replayMarker}TAIL`, declaredTotalChars: 8 },
  { reason: "no marker exists", value: "HEADTAIL", declaredTotalChars: 80 },
  { reason: "short evidence has no marker", value: "HEAD", declaredTotalChars: undefined },
];

for (const { reason, value, declaredTotalChars } of invalidReplays) {
  test(`replayed evidence is capped again when ${reason}`, () => {
    assert.deepEqual(
      capReplayedControllerEvidence(value, declaredTotalChars, 4),
      capControllerEvidence(value, 4),
    );
  });
}

test("per-job controller evidence cap is deterministic and preserves the true total", () => {
  const source = `HEAD\n${"A".repeat(75_730)}\nTAIL`;

  const first = capControllerEvidence(source, 12_000);
  const second = capControllerEvidence(source, 12_000);

  assert.deepEqual(first, second);
  assert.equal(first.totalChars, source.length);
  assert.equal(first.truncatedChars, source.length - 12_000);
  assert.ok(first.value.startsWith(source.slice(0, 12_000)));
  assert.match(
    first.value,
    new RegExp(
      `\\[job evidence capped: ${source.length - 12_000} chars omitted; total_chars=${source.length}; cap=12000\\]$`,
    ),
  );
  assert.doesNotMatch(first.value, /TAIL$/);
});

test("per-job evidence cap rejects non-positive runtime limits", () => {
  assert.throws(
    () => validateControllerRuntimeOptions({ maxJobEvidenceChars: 0 }),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "MAX_JOB_EVIDENCE_CHARS_INVALID",
  );
});

test("capped evidence pagination keeps one hash and never offsets into discarded output", () => {
  const runId = "run_capped_evidence_hash";
  const source = `HEAD\n${"B".repeat(75_750)}\nDISCARDED_TAIL`;
  const capped = capControllerEvidence(source, 20_000);
  const state = initialRunState(runId, "Inspect capped evidence", "caller");
  const job: JobObservation = {
    job_id: "job_capped_evidence_hash",
    job_key: "large_advise",
    required: true,
    status: "succeeded",
    output: capped.value,
    output_total_chars: capped.totalChars,
  };

  const first = observationFor(state, 2, "msg_capped_first", [job]);
  const firstWindow = first.jobs[0]!.evidence_window!;
  assert.equal(first.jobs[0]!.output_total_chars, source.length);
  assert.equal(firstWindow.total_chars, capped.value.length);
  assert.equal(
    firstWindow.content_hash,
    commandHash({ field: "output", value: capped.value }),
  );
  assert.equal(typeof firstWindow.next_offset, "number");

  state.inspectionJobIds = [job.job_id];
  state.inspectionEvidenceOffset = firstWindow.next_offset!;
  state.inspectionEvidenceHash = firstWindow.content_hash;
  const second = observationFor(state, 3, "msg_capped_second", [job]);
  const secondWindow = second.jobs[0]!.evidence_window!;
  assert.equal(secondWindow.offset, firstWindow.next_offset);
  assert.equal(secondWindow.content_hash, firstWindow.content_hash);
  assert.equal(secondWindow.next_offset, null);
  assert.equal(secondWindow.end, capped.value.length);
  assert.doesNotMatch(second.jobs[0]!.output ?? "", /DISCARDED_TAIL/);
});

test("capacity warning uses the incident arithmetic at round seven of twelve", () => {
  assert.equal(
    controllerEvidenceCapacityNotice(75_762 + 70_738, 7, 12),
    "[controller evidence capacity warning: evidence total 146500 chars exceeds remaining round capacity 72000 chars; decide from summaries or dispatch a summarization task instead of paging]",
  );
  assert.equal(controllerEvidenceCapacityNotice(72_000, 7, 12), undefined);
  assert.equal(controllerEvidenceCapacityNotice(1_000_000, 7, null), undefined);
});

test("controller observation capacity counts only servable capped representations", () => {
  const state = initialRunState(
    "run_capacity_notice",
    "Decide without a paging treadmill",
    "caller",
    12,
  );
  const jobs: JobObservation[] = [75_762, 70_738].map((total, index) => {
    const capped = capControllerEvidence(String(index + 1).repeat(total), 12_000);
    return {
      job_id: `job_capacity_${index + 1}`,
      job_key: `capacity_${index + 1}`,
      required: true,
      status: "succeeded",
      output: capped.value,
      output_total_chars: capped.totalChars,
    };
  });

  const observation = observationFor(state, 7, "msg_capacity_notice", jobs);
  assert.equal(
    observation.notices.some((notice) => notice.includes("evidence capacity warning")),
    false,
  );
  assert.ok(
    observation.notices.some((notice) =>
      notice.includes("capacity warning counts only servable capped representation chars"),
    ),
  );

  const finalRound = observationFor(state, 12, "msg_capacity_notice_final", jobs);
  const servableChars = jobs.reduce((total, job) => total + (job.output?.length ?? 0), 0);
  assert.ok(
    finalRound.notices.includes(
      `[controller evidence capacity warning: evidence total ${servableChars} chars exceeds remaining round capacity 12000 chars; decide from summaries or dispatch a summarization task instead of paging]`,
    ),
  );
});
