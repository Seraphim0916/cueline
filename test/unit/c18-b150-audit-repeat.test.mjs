import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import test from 'node:test';

const dataUrl = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const synthetic = `sk-ant-${'a'.repeat(25)}`;
const github = `ghp_${'b'.repeat(36)}`;
const keyPreview = `sk-a…(${synthetic.length} chars)`;
const events = [
  { sequence: 2, type: 'fixture_event', payload: {
    first: `${synthetic}; ${synthetic}`,
    nested: { list: [synthetic, { [synthetic]: 'ordinary', value: `Bearer ${synthetic}` }] },
  } },
  { sequence: 7, type: 'fixture_repeat', payload: { repeat: synthetic, github } },
];

// Load the entire production scanner; replace only its external event reader.
const readerUrl = dataUrl(`export const readAuthoritativeRunEvents = async () => ${JSON.stringify(events)};`);
let source = await readFile(new URL('../../src/diagnostics/secret-audit.ts', import.meta.url), 'utf8');
source = source.replace('"../core/errors.js"', JSON.stringify(dataUrl(
  await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'))));
source = source.replace('"../core/runtime.js"', JSON.stringify(dataUrl(
  'export const runtimeEnvironment = () => { throw new Error("explicit environment required"); };')));
source = source.replace('"../state/paths.js"', JSON.stringify(dataUrl(
  'export const defaultCueLineHome = () => { throw new Error("explicit home required"); };')));
source = source.replace('"../state/store.js"', JSON.stringify(readerUrl));
const { auditCueLineRunSecrets } = await import(dataUrl(source));

test('repeated public scans preserve every field, array and key finding without leaking values', async () => {
  const options = { home: tmpdir(), environment: {} };
  const first = await auditCueLineRunSecrets('run_synthetic_repeat', options);
  const second = await auditCueLineRunSecrets('run_synthetic_repeat', options);
  assert.deepEqual(second, first);
  assert.equal(first.protocol, 'cueline-secret-audit/0.1');
  assert.equal(first.runId, 'run_synthetic_repeat');
  assert.equal(first.scannedEvents, 2);
  assert.equal(first.scannedFields, 6);
  assert.equal(first.clean, false);
  const expected = [
    [2, 'fixture_event', 'payload.first'],
    [2, 'fixture_event', 'payload.first'],
    [2, 'fixture_event', 'payload.nested.list[0]'],
    [2, 'fixture_event', `payload.nested.list[1].${keyPreview}`],
    [2, 'fixture_event', 'payload.nested.list[1].value'],
    [7, 'fixture_repeat', 'payload.repeat'],
  ].map(([sequence, eventType, path]) => ({ sequence, eventType, path,
    kind: 'anthropic_api_key', matchLength: synthetic.length, maskedPreview: keyPreview }));
  expected.push({ sequence: 7, eventType: 'fixture_repeat', path: 'payload.github',
    kind: 'github_token', matchLength: github.length, maskedPreview: `ghp_…(${github.length} chars)` });
  expected.sort((a, b) => a.sequence - b.sequence || a.path.localeCompare(b.path));
  assert.deepEqual(first.findings, expected);
  // Bearer + a specific key overlap: only the specific detector may claim it.
  assert.equal(first.findings.filter(f => f.path === 'payload.nested.list[1].value').length, 1);
  for (const report of [first, second]) {
    const output = JSON.stringify(report);
    for (const value of [synthetic, github, 'a'.repeat(25), 'b'.repeat(36)]) {
      assert.equal(output.includes(value), false);
    }
  }
});
