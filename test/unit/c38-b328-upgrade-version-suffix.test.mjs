import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test from 'node:test';

const entry = new URL('../../src/diagnostics/upgrade-preflight.ts', import.meta.url).href;
const versionSource = await readFile(new URL('../../src/version.ts', import.meta.url), 'utf8');
const current = versionSource.match(/CUELINE_VERSION\s*=\s*["']([^"']+)["']/)?.[1];
assert.ok(current, 'read the actual current version');
const newer = `${Number(current.split('.')[0]) + 1}.0.0`;
const stubs = new Map([
  ['node:fs/promises', `export async function lstat() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }
    export async function readdir() { return []; }
    export async function readFile() { throw new Error('unexpected file read'); }`],
  ['../api.js', `export async function listCueLineRuns() { return []; }
    export function routingConfigPath() { return '/fixture/config.json'; }`],
  ['../jobs/status.js', 'export function isLegacyJobStatusSource() { return false; }'],
  ['../router/config-loader.js', 'export async function loadRoutingConfig() { return {}; }'],
  ['../state/paths.js', "export function defaultCueLineHome() { return '/fixture/home'; }"],
  ['../version.js', `export const CUELINE_VERSION = ${JSON.stringify(current)};`],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === entry && stubs.has(specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(stubs.get(specifier))}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
let collectUpgradePreflight;
try {
  ({ collectUpgradePreflight } = await import(entry));
} finally {
  hooks.deregister();
}

for (const [label, suffix] of [
  ['LF', '\n'], ['CR', '\r'], ['U+2028', '\u2028'], ['U+2029', '\u2029'],
  ['CRLF', '\r\n'], ['mixed', '\n\r\u2028\u2029'],
]) {
  test(`public preflight rejects trailing ${label}`, async () => {
    const report = await collectUpgradePreflight({ targetVersion: newer + suffix, nodeVersion: '22.0.0', environment: {} });
    assert.equal(report.targetVersion, newer + suffix);
    assert.equal(report.status, 'blocked');
    assert.deepEqual(report.findings.map(({ code }) => code), ['TARGET_VERSION_INVALID']);
  });
}

test('public preflight accepts a clean newer version', async () => {
  const report = await collectUpgradePreflight({ targetVersion: newer, nodeVersion: '22.0.0', environment: {} });
  assert.equal(report.status, 'ready');
  assert.deepEqual(report.findings, []);
});
