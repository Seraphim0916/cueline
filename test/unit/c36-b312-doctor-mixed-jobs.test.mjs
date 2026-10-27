import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { compileFunction } from 'node:vm';

const source = stripTypeScriptTypes(await readFile(
  new URL('../../src/diagnostics/run-doctor.ts', import.meta.url), 'utf8',
)).replace(/^import\b[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
const diagnose = compileFunction(`${source}\nreturn diagnoseCueLineRunStatus;`)();

const groups = [
  ['a', 'ambiguous', 'AMBIGUOUS_JOB_PRESENT', 'error'],
  ['o', 'orphaned', 'ORPHANED_JOB_PRESENT', 'error'],
  ['t', 'timed_out', 'TIMED_OUT_JOB_EVIDENCE', 'warning'],
  ['f', 'failed', 'FAILED_JOB_EVIDENCE', 'warning'],
];

function snapshot(items) {
  const counts = Object.fromEntries([
    'pending', 'running', 'succeeded', 'cancelled', 'ambiguous', 'orphaned', 'timed_out', 'failed',
  ].map((state) => [state, items.filter((job) => job.status === state).length]));
  return {
    runId: 'run', status: 'running', phase: 'jobs_running', safeNextAction: 'observe',
    lastEventSequence: 17, runtime: { ownership: 'active' }, controller: { pendingTurns: 0 },
    jobs: { total: items.length, counts, items },
  };
}

function* permutations(items) {
  if (!items.length) { yield []; return; }
  for (let index = 0; index < items.length; index++) {
    for (const tail of permutations(items.filter((_, position) => position !== index))) {
      yield [items[index], ...tail];
    }
  }
}

for (const [name, selected, outcome] of [
  ['normal', [], 'healthy'],
  ['warnings', groups.slice(2), 'action_required'],
  ['ambiguous with warnings', [groups[0], ...groups.slice(2)], 'blocked'],
  ['orphaned with warnings', groups.slice(1), 'blocked'],
  ['all four groups', groups, 'blocked'],
]) {
  test(`${name}: grouping and severity are stable across input permutations`, (t) => {
    let checked = 0;
    for (const order of permutations(selected)) {
      const items = order.map(([jobId, status]) => ({ jobId, status }));
      items.splice(1, 0, { jobId: 'normal-running', status: 'running' });
      items.push({ jobId: 'normal-succeeded', status: 'succeeded' });
      const input = snapshot(items);
      const before = structuredClone(input);
      const result = diagnose(input);
      assert.equal(result.outcome, outcome);
      assert.equal(result.findings[0].severity, 'info');
      const actual = result.findings.slice(1).map(({ code, severity, evidence }) => ({
        code, severity, evidence,
      }));
      const expected = groups.filter((group) => selected.includes(group))
        .map(([jobId, , code, severity]) => ({
          code, severity, evidence: { count: 1, job_ids: jobId },
        }));
      assert.deepEqual(actual, expected);
      assert.deepEqual(input, before, 'diagnosis must not mutate input or reorder jobs');
      checked++;
    }
    t.diagnostic(`${outcome} permutations ${checked} unchanged true`);
  });
}
