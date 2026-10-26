import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';

if (!vm.SourceTextModule) {
  test('history gaps with VM modules', () => {
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 30_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
} else {
  async function fixture() {
    const context = vm.createContext({});
    const load = async (name) => new vm.SourceTextModule(stripTypeScriptTypes(await readFile(new URL(name, import.meta.url), 'utf8')), { context });
    const errors = await load('../../src/core/errors.ts');
    const events = [
      { sequence: 1, type: 'run_started', timestamp: '2026-01-01T00:00:00Z' },
      { sequence: 3, type: 'run_completed', timestamp: '2026-01-01T00:00:03Z' },
    ];
    const calls = [];
    const dependencies = {
      '../core/persisted-run.js': { loadPersistedRunStore: async () => {} },
      '../state/event-log.js': { readEvents: async () => events },
      '../state/paths.js': { defaultCueLineHome: () => '/virtual', runPaths: () => ({ events: '/virtual/events' }) },
      '../state/store.js': { readAuthoritativeRunEvents: async () => events },
      '../core/state-machine.js': {
        initialRunState: () => {
          calls.push('initial');
          return {
            status: 'running', executor: 'caller', allowProcessExecution: false,
            round: 0, maxRounds: null, maxStagnantRounds: 12, stagnantRounds: 0,
            conversationUrl: null, pendingControllerTurns: [], abandonedControllerTurns: [],
            commandHashes: [], pendingCommandExecution: null, jobs: {},
            controllerConversationArchive: { status: 'disabled' },
            finalDeliveryText: null, blockedReason: null, cancelledReason: null,
          };
        },
        reduceRunState: (state, event) => {
          calls.push(event.sequence);
          return { ...state, status: event.sequence === 3 ? 'complete' : 'running', round: event.sequence };
        },
      },
    };
    const subject = await load('../../src/observation/run-status-at.ts');
    await subject.link((specifier) => {
      if (specifier === '../core/errors.js') return errors;
      const exports = dependencies[specifier];
      assert.ok(exports, specifier);
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context });
    });
    await subject.evaluate();
    return { query: (sequence) => subject.namespace.loadCueLineRunStatusAt('run_gap', { sequence, home: '/virtual', environment: {} }), calls, events };
  }
  for (const [sequence, code, message] of [
    [2, 'RUN_STATUS_AT_SEQUENCE_MISSING', "Run 'run_gap' has no durable event at sequence 2."],
    [4, 'RUN_STATUS_AT_SEQUENCE_AHEAD', "Run 'run_gap' is at event 3, behind requested sequence 4."],
  ]) {
    test(`sparse [1,3] query ${sequence} rejects precisely before reconstruction`, async () => {
      const f = await fixture();
      await assert.rejects(f.query(sequence), { code, message });
      assert.deepEqual(f.calls, [], 'neither initial state nor reducer may run');
    });
  }
  for (const sequence of [1, 3]) {
    test(`sparse [1,3] query existing ${sequence} reconstructs exactly through that event`, async () => {
      const f = await fixture();
      const result = await f.query(sequence);
      assert.equal(result.requestedSequence, sequence);
      assert.equal(result.latestSequence, 3);
      assert.equal(result.latestAuthoritativeSequence, 3);
      assert.equal(result.totalEvents, 2);
      assert.equal(result.authoritativeEventsApplied, sequence === 1 ? 1 : 2);
      assert.equal(result.ignoredNonAuthoritativeEventsThroughSequence, 0);
      assert.equal(result.asOf.type, f.events.find((event) => event.sequence === sequence).type);
      assert.equal(result.asOf.timestamp, f.events.find((event) => event.sequence === sequence).timestamp);
      assert.equal(result.state.status, sequence === 1 ? 'running' : 'complete');
      assert.equal(result.state.round, sequence);
      assert.deepEqual(f.calls, sequence === 1 ? ['initial', 1] : ['initial', 1, 3]);
    });
  }
}
