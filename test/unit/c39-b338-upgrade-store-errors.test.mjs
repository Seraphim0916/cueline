import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataUrl = source => `data:text/javascript,${encodeURIComponent(source)}`;
const fixtureUrl = dataUrl(`
  let filesystem;
  export const configure = value => { filesystem = value; };
  export const lstat = (...args) => filesystem.lstat(...args);
  export const readdir = (...args) => filesystem.readdir(...args);
  export const readFile = (...args) => filesystem.readFile(...args);
  export const listCueLineRuns = async () => [];
  export const routingConfigPath = () => 'test-routing.json';
  export const loadRoutingConfig = async () => ({});
`);
const { configure } = await import(fixtureUrl);
const cache = new Map();
async function moduleUrl(url) {
  if (cache.has(url.href)) return cache.get(url.href);
  let source = stripTypeScriptTypes(await readFile(url, 'utf8'));
  const preflight = url.pathname.endsWith('/upgrade-preflight.ts');
  if (preflight) source = source.replace('"node:fs/promises"', JSON.stringify(fixtureUrl));
  for (const match of [...source.matchAll(/from "(\.[^"]+\.js)"/g)]) {
    const dependency = preflight && ['../api.js', '../router/config-loader.js'].includes(match[1])
      ? fixtureUrl : await moduleUrl(new URL(match[1].replace(/\.js$/, '.ts'), url));
    source = source.replaceAll(`"${match[1]}"`, JSON.stringify(dependency));
  }
  const result = dataUrl(source);
  cache.set(url.href, result);
  return result;
}
const { collectUpgradePreflight } = await import(await moduleUrl(
  new URL('../../src/diagnostics/upgrade-preflight.ts', import.meta.url),
));
const home = path.join(tmpdir(), 'c39-b338-virtual-home');
const failure = code => Object.assign(new Error(code), { code });
const entry = name => ({ name, isFile: () => true });

for (const scenario of ['missing', 'denied', 'partial']) {
  test(`${scenario}: directory and individual file failures remain distinct`, async () => {
    const fileReads = [], directoryReads = [];
    configure({
      async lstat(file) {
        assert.equal(file, home);
        if (scenario === 'missing') throw failure('ENOENT');
        return { isSymbolicLink: () => false, isDirectory: () => true, mode: 0o700 };
      },
      async readdir(directory, options) {
        directoryReads.push(directory);
        assert.deepEqual(options, { withFileTypes: true });
        if (scenario !== 'partial') throw failure(scenario === 'missing' ? 'ENOENT' : 'EACCES');
        return [entry('unreadable.json'), entry('legacy.terminal'), entry('current.json')];
      },
      async readFile(file, encoding) {
        fileReads.push(path.basename(file));
        assert.equal(path.dirname(file), path.join(home, 'jobs'));
        assert.equal(encoding, 'utf8');
        if (file.endsWith('unreadable.json')) throw failure('EACCES');
        return JSON.stringify({ result: file.endsWith('legacy.terminal') ? {} : { cancelled: false } });
      },
    });
    const report = await collectUpgradePreflight({
      targetVersion: '999.0.0', nodeVersion: '22.0.0', environment: { CUELINE_HOME: home },
    });
    assert.deepEqual(directoryReads, [path.join(home, 'jobs')]);
    assert.equal(report.status, scenario === 'denied' ? 'blocked' : 'ready');
    assert.deepEqual(report.checks.runs, {
      total: 0, nonTerminal: 0, unreadable: 0, legacyJobEvidence: scenario === 'partial' ? 1 : 0,
    });
    assert.deepEqual(report.findings.map(({ code, severity, surface }) => ({ code, severity, surface })),
      scenario === 'missing' ? [] : [{
        code: scenario === 'denied' ? 'RUN_STORE_UNREADABLE' : 'LEGACY_JOB_EVIDENCE_PRESENT',
        severity: scenario === 'denied' ? 'blocker' : 'warning', surface: 'runs',
      }]);
    assert.deepEqual(fileReads, scenario === 'partial'
      ? ['unreadable.json', 'legacy.terminal', 'current.json'] : []);
  });
}
