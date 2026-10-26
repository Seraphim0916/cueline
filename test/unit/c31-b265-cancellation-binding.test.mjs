import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// C2-B265: a cancellation request only counts for its own run and its own target kind, through both public
// readers. src/state/cancellation.ts reaches a TypeScript parameter property, which Node's strip-only type
// removal rejects (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX), so the compiled build is loaded instead; it must not be
// older than the source it was built from.
async function fromDist(relative) {
  const built = new URL(`../../dist/src/${relative}.js`, import.meta.url);
  const source = new URL(`../../src/${relative}.ts`, import.meta.url);
  const [builtStat, sourceStat] = await Promise.all([fs.stat(built), fs.stat(source)]);
  assert.ok(builtStat.mtimeMs >= sourceStat.mtimeMs, `dist/src/${relative}.js is older than its source; run npm run build`);
  return import(built.href);
}

const subject = await fromDist('state/cancellation');
const { runPaths } = await fromDist('state/paths');
const runId = 'run_binding';
const base = { protocol: 'cueline/cancellation/0.1', run_id: runId,
  reason: 'stop', requested_at: '2026-10-26T00:00:00.000Z' };
const run = { ...base, target: 'run' };
const job = { ...base, target: 'job', job_id: 'job_a' };

for (const [kind, read, valid, wrongTarget] of [
  ['run', subject.readRunCancellation, run, job],
  ['job', subject.readJobCancellations, job, run],
]) {
  for (const [label, record] of [
    ['other run_id', { ...valid, run_id: 'run_other' }],
    ['wrong target', wrongTarget],
    ['valid binding', valid],
  ]) {
    test(`${kind}: ${label}`, async (t) => {
      const home = await fs.mkdtemp(path.join(tmpdir(), 'c31-binding-'));
      t.after(() => fs.rm(home, { recursive: true, force: true }));
      const paths = runPaths(home, runId);
      const file = kind === 'run' ? paths.runCancellation : path.join(paths.jobCancellationsDir, 'job_a.json');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(record));
      if (label === 'valid binding') {
        assert.deepEqual(JSON.parse(JSON.stringify(await read(home, runId))), kind === 'run' ? valid : [valid]);
      } else {
        await assert.rejects(read(home, runId), { code: 'CANCELLATION_REQUEST_INVALID' });
      }
    });
  }
}

test('job: a run request is refused by its target, not only by its file name', async (t) => {
  // A run request has no job_id, so stored as job_a.json it also fails the file-name check. Named
  // "undefined.json" it passes that check, and only the target check can refuse it.
  const home = await fs.mkdtemp(path.join(tmpdir(), 'c31-binding-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const directory = runPaths(home, runId).jobCancellationsDir;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'undefined.json'), JSON.stringify(run));
  await assert.rejects(subject.readJobCancellations(home, runId), { code: 'CANCELLATION_REQUEST_INVALID' });
});
