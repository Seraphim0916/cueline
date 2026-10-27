import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import test from 'node:test';

const root = new URL('../../src/', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === root + 'observation/run-handoff.ts') {
      const name = { '../api-runtime-lifecycle.js': 'loadCueLineRunStatus',
        '../core/persisted-run.js': 'loadPersistedRunStore' }[specifier];
      if (name) return nextResolve('data:text/javascript,' + encodeURIComponent(
        `export function ${name}() { throw new Error('unexpected persisted I/O'); }`), context);
    }
    if (context.parentURL?.startsWith(root) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
let buildCueLineRunHandoff, renderCueLineRunHandoffMarkdown, initialRunState, summarizeCueLineRunState;
try {
  ({ buildCueLineRunHandoff, renderCueLineRunHandoffMarkdown } = await import('../../src/observation/run-handoff.ts'));
  ({ initialRunState } = await import('../../src/core/state-machine.ts'));
  ({ summarizeCueLineRunState } = await import('../../src/core/run-status.ts'));
} finally { hooks.deregister(); }

function packet(options, final = 'FINAL_C35\n"quoted"\\', blocked = 'BLOCK_C35\n"quoted"\\') {
  const run = initialRunState('run_c35', 'request', 'caller', 12, false);
  run.finalDeliveryText = final;
  run.blockedReason = blocked;
  return buildCueLineRunHandoff(run, summarizeCueLineRunState(run, 0, { ownership: 'missing' }), tmpdir(), options);
}

test('Markdown preserves both terminal fields with JSON string escaping', () => {
  const value = packet({ includeContent: true });
  const markdown = renderCueLineRunHandoffMarkdown(value);
  assert.ok(markdown.includes(`- Final delivery: ${JSON.stringify(value.content.finalDeliveryText)}`));
  assert.ok(markdown.includes(`- Blocked reason: ${JSON.stringify(value.content.blockedReason)}`));
  assert.ok(!markdown.includes('FINAL_C35\n'));
  assert.ok(!markdown.includes('BLOCK_C35\n'));
});

test('default and explicit metadata policy hide terminal content', () => {
  for (const options of [{}, { includeContent: false }]) {
    const value = packet(options);
    assert.equal(value.content, undefined);
    assert.doesNotMatch(renderCueLineRunHandoffMarkdown(value), /FINAL_C35|BLOCK_C35|Final delivery:|Blocked reason:/);
  }
});

test('rendering uses only the already bounded terminal values', () => {
  const value = packet({ includeContent: true, maxContentChars: 64 }, 'F'.repeat(500) + 'FINAL_TAIL', 'B'.repeat(500) + 'BLOCK_TAIL');
  const content = value.content;
  assert.ok(content.request.length + content.finalDeliveryText.length + content.blockedReason.length <= 64);
  const markdown = renderCueLineRunHandoffMarkdown(value);
  for (const field of ['finalDeliveryText', 'blockedReason']) {
    assert.match(content[field], /\[truncated\]$/);
    assert.ok(markdown.includes(JSON.stringify(content[field])));
  }
  assert.doesNotMatch(markdown, /FINAL_TAIL|BLOCK_TAIL/);
});

test('absent fields are omitted but present empty strings are preserved', () => {
  for (const [final, blocked] of [[null, null], ['', null], [null, '']]) {
    const markdown = renderCueLineRunHandoffMarkdown(packet({ includeContent: true }, final, blocked));
    assert.equal(markdown.includes('- Final delivery: ""'), final === '');
    assert.equal(markdown.includes('- Blocked reason: ""'), blocked === '');
    assert.doesNotMatch(markdown, /Final delivery: (null|undefined)|Blocked reason: (null|undefined)/);
  }
});
