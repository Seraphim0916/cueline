import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = await readFile(new URL('../../src/state/runtime-record-validation.ts', import.meta.url), 'utf8');
const { parseRetiredRuntimeOwners } = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`);
const record = () => ({ owner_id: 'owner', events_after_sequence: 7, retired_at: '2026-10-26T00:00:00.000Z' });

for (const index of [0, 1, 2]) {
  test(`retirement parser rejects a hole at index ${index}`, () => {
    const input = [record(), record(), record()];
    delete input[index];
    assert.throws(() => parseRetiredRuntimeOwners(input), { message: 'RUNTIME_LEASE_INVALID' });
  });
}
test('entirely sparse array rejects at the function boundary', () => {
  assert.throws(() => parseRetiredRuntimeOwners(Array(1)), { message: 'RUNTIME_LEASE_INVALID' });
});
test('dense records are copied and undefined remains an empty list', () => {
  const input = [record(), { ...record(), owner_id: 'second' }];
  const output = parseRetiredRuntimeOwners(input);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  output.forEach((item, index) => assert.notEqual(item, input[index]));
  assert.deepEqual(parseRetiredRuntimeOwners(undefined), []);
  assert.deepEqual(parseRetiredRuntimeOwners([]), []);
  assert.throws(() => parseRetiredRuntimeOwners([undefined]), { message: 'RUNTIME_LEASE_INVALID' });
});
