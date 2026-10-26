import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const dataUrl = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const selectors = dataUrl(await readFile(new URL('../../src/browser/codex-iab/selectors.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../../src/browser/codex-iab/send-button.ts', import.meta.url), 'utf8');
const { inspectVisibleSendButton } = await import(dataUrl(source.replace('"./selectors.js"', JSON.stringify(selectors))));

function validTarget() {
  return {
    coordinate: { x: 30, y: 40 },
    buttonRect: { x: 10, y: 20, width: 40, height: 40, top: 20, right: 50, bottom: 60, left: 10 },
    viewport: { width: 800, height: 600 },
    devicePixelRatio: 2,
    elementFromPoint: null,
    elementFromPointButtonAncestor: null,
    elementFromPointMatchesButton: true,
    documentHasFocus: true,
    documentVisibilityState: 'visible',
  };
}
const inspect = target => inspectVisibleSendButton({ id: 'geometry', playwright: { evaluate: async () => target } });
function set(target, path, value) {
  const keys = path.split('.');
  if (keys.length === 1) target[keys[0]] = value;
  else target[keys[0]][keys[1]] = value;
}

test('rejects every non-finite geometry field and negative coordinates', async () => {
  const fields = [
    'coordinate.x', 'coordinate.y',
    ...['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left'].map(key => `buttonRect.${key}`),
    'viewport.width', 'viewport.height', 'devicePixelRatio',
  ];
  const cases = fields.flatMap(path => [NaN, Infinity, -Infinity].map(value => [path, value]));
  cases.push(['coordinate.x', -1], ['coordinate.y', -1]);
  let rejected = 0;
  for (const [path, value] of cases) {
    const target = validTarget();
    set(target, path, value);
    assert.equal(await inspect(target), undefined, `${path}=${value}`);
    rejected += 1;
  }
  const target = validTarget();
  assert.deepEqual(await inspect(target), { tabId: 'geometry', ...target });
  console.log(`total: ${cases.length}, rejected: ${rejected}, validAccepted: true`);
});

test('rejects zero and negative sizes and pixel ratios, but accepts zero coordinates', async () => {
  for (const path of ['buttonRect.width', 'buttonRect.height', 'viewport.width', 'viewport.height', 'devicePixelRatio']) {
    for (const value of [0, -1]) {
      const target = validTarget();
      set(target, path, value);
      assert.equal(await inspect(target), undefined, `${path}=${value}`);
    }
  }
  const target = validTarget();
  target.coordinate = { x: 0, y: 0 };
  assert.deepEqual((await inspect(target)).coordinate, { x: 0, y: 0 });
});
