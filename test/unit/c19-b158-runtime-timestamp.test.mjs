import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = await readFile(new URL('../../src/state/runtime-record-validation.ts', import.meta.url), 'utf8');
const { isCanonicalRuntimeTimestamp, isRuntimeOwnerRetirementEvidence, parseRetiredRuntimeOwners } =
  await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`);

for (const [name, timestamp, expected] of [
  ['leap day', '2024-02-29T00:00:00.000Z', true],
  ['invalid leap day', '2023-02-29T00:00:00.000Z', false],
  ['equivalent timezone offset', '2024-02-29T08:00:00.000+08:00', false],
  ['missing milliseconds', '2024-02-29T00:00:00Z', false],
  ['extra precision', '2024-02-29T00:00:00.0000Z', false],
]) {
  test(`canonical timestamp: ${name}`, () => {
    assert.equal(isCanonicalRuntimeTimestamp(timestamp), expected);
  });
  test(`retirement evidence uses canonical timestamp: ${name}`, () => {
    const evidence = { owner_id: 'owner-1', events_after_sequence: 0, retired_at: timestamp };
    assert.equal(isRuntimeOwnerRetirementEvidence(evidence), expected);
    if (expected) {
      assert.deepEqual(parseRetiredRuntimeOwners([evidence]), [evidence]);
    } else {
      assert.throws(() => parseRetiredRuntimeOwners([evidence]), { message: 'RUNTIME_LEASE_INVALID' });
    }
  });
}
