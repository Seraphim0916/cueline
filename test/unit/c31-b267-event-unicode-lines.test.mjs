import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// C2-B267: event JSONL records end at LF only. NEL (U+0085), LINE SEPARATOR (U+2028) and PARAGRAPH SEPARATOR
// (U+2029) inside a payload are content, not record boundaries. Read through the public readEvents().
const sourceRoot = new URL('../../src/', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot)
        && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
let readEvents;
try {
  ({ readEvents } = await import('../../src/state/event-log.ts'));
} finally {
  hooks.deregister();
}

const SEPARATORS = '\u0085  ';
const event = (sequence, text) => ({ sequence, timestamp: '2026-10-26T00:00:00.000Z', type: 'note', payload: { text } });

async function legacyLog(t, contents) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'c31-events-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'events.jsonl');
  await fs.writeFile(file, contents, 'utf8');
  return file;
}

function line(value) {
  const text = JSON.stringify(value);
  // JSON.stringify leaves these characters unescaped; the test needs them raw in the file.
  for (const character of SEPARATORS) {
    if (JSON.stringify(value.payload.text).includes(character)) assert.ok(text.includes(character));
  }
  return text;
}

test('separators inside one payload stay in that payload', async (t) => {
  const text = `before${SEPARATORS[0]}a${SEPARATORS[1]}b${SEPARATORS[2]}after`;
  const events = await readEvents(await legacyLog(t, `${line(event(1, text))}\n`));
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.text, text);
});

test('two adjacent events whose payloads end and start with separators stay two events', async (t) => {
  const first = `one${SEPARATORS}`;
  const second = `${SEPARATORS}two`;
  const events = await readEvents(await legacyLog(t, `${line(event(1, first))}\n${line(event(2, second))}\n`));
  assert.deepEqual(events.map((e) => [e.sequence, e.payload.text]), [[1, first], [2, second]]);
});

test('plain LF and CRLF line endings still separate records', async (t) => {
  for (const [ending, label] of [['\n', 'LF'], ['\r\n', 'CRLF']]) {
    const contents = `${line(event(1, 'a'))}${ending}${line(event(2, `b${SEPARATORS}`))}${ending}`;
    const events = await readEvents(await legacyLog(t, contents));
    assert.deepEqual(events.map((e) => [e.sequence, e.payload.text]), [[1, 'a'], [2, `b${SEPARATORS}`]], label);
  }
});
