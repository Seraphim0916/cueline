import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const errors = dataUrl(await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'));
const guard = dataUrl(await readFile(new URL('../../src/browser/claude-desktop/lane-status-guard.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../../src/browser/claude-desktop/lane-runner.ts', import.meta.url), 'utf8');
const { runClaudeDesktopLane } = await import(dataUrl(source
  .replace('"../../core/errors.js"', JSON.stringify(errors))
  .replace('"./lane-status-guard.js"', JSON.stringify(guard))));
const { CueLineError } = await import(errors);

for (const kind of ['start', 'resume']) {
  test(`${kind}: initial record failure preserves run identity and prevents preparation`, async () => {
    const runId = `run-initial-${kind}`;
    const initialEvent = kind === 'start' ? 'created' : 'resuming';
    const records = [];
    let starts = 0;
    const later = [];
    const forbidden = (stage) => async () => { later.push(stage); assert.fail(`unexpected ${stage}`); };
    const failure = new CueLineError('INITIAL_RECORD_FAIL', 'initial record unavailable');
    const result = await runClaudeDesktopLane({
      mode: kind === 'start' ? { kind, request: 'fixture request' } : { kind, runId },
      startRun: async (request) => {
        starts += 1;
        assert.equal(request, 'fixture request');
        return { runId, status: 'running' };
      },
      persistedConversationUrl: forbidden('url'),
      createBrowser: forbidden('browser'),
      loadStatus: forbidden('load'),
      continueRun: forbidden('continue'),
      sleep: forbidden('sleep'),
      record: async (entry) => {
        records.push(entry);
        if (entry.event === initialEvent) throw failure;
      },
    });
    assert.deepEqual(result, { outcome: 'stopped', runId, code: 'INITIAL_RECORD_FAIL' });
    assert.equal(starts, kind === 'start' ? 1 : 0);
    assert.deepEqual(later, []);
    assert.deepEqual(records.map(({ event }) => event), [initialEvent, 'failed']);
    assert.equal(records[0].runId, runId);
    assert.deepEqual(records[1], {
      event: 'failed', runId, code: 'INITIAL_RECORD_FAIL', message: failure.message,
      resume: `cueline-claude-desktop-lane daemon --resume ${runId}`,
    });
  });
}
