import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const dataUrl = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
let source = stripTypeScriptTypes(await readFile(new URL('../../src/diagnostics/secret-audit.ts', import.meta.url), 'utf8'));
source = source.replace('"../core/errors.js"', JSON.stringify(dataUrl(await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'))));
source = source.replace(/import .* from "..\/core\/runtime.js";/, 'const runtimeEnvironment = () => ({});');
source = source.replace(/import .* from "..\/state\/paths.js";/, 'const defaultCueLineHome = () => "unused";');
source = source.replace(/import .* from "..\/state\/store.js";/, 'const readAuthoritativeRunEvents = async (payload) => [{ sequence: 1, type: "fake_event", payload: JSON.parse(payload) }];');
const { auditCueLineRunSecrets } = await import(dataUrl(source));
const audit = payload => auditCueLineRunSecrets('run_synthetic', { home: JSON.stringify(payload), environment: {} });

for (const scheme of ['Bearer', 'bearer', 'BEARER', 'bEaReR']) {
  test(`${scheme}: detects synthetic token and masks value and key`, async () => {
    const text = `${scheme} ${'z'.repeat(20)}`;
    const report = await audit({ [text]: text });
    assert.equal(report.findings.length, 2);
    for (const finding of report.findings) {
      assert.equal(finding.kind, 'bearer_token');
      assert.equal(finding.matchLength, text.length);
      assert.equal(finding.maskedPreview, `${scheme.slice(0, 4)}…(${text.length} chars)`);
    }
    assert.equal(JSON.stringify(report).includes(text), false, 'report must not expose synthetic match');
    assert.equal(JSON.stringify(report).includes('z'.repeat(20)), false, 'report must not expose synthetic token');
  });
  test(`${scheme}: keeps length threshold and overlap precedence`, async () => {
    assert.equal((await audit({ text: `${scheme} ${'z'.repeat(19)}` })).clean, true);
    const report = await audit({ text: `${scheme} sk-ant-${'z'.repeat(25)}` });
    assert.deepEqual(report.findings.map(f => f.kind), ['anthropic_api_key']);
  });
}
test('multiple matches and subsequent scans do not retain regexp state', async () => {
  const payload = { text: `bearer ${'z'.repeat(20)}; BEARER ${'q'.repeat(20)}` };
  for (let index = 0; index < 2; index += 1) {
    assert.equal((await audit(payload)).findings.length, 2);
  }
});
