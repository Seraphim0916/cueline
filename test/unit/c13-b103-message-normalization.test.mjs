import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

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
let normalizedMessageText;
try {
  ({ normalizedMessageText } = await import('../../src/browser/codex-iab/recovery-evidence.ts'));
} finally {
  hooks.deregister();
}

const cases = [
  ['mixed whitespace', '\u00a0\t甲\u00a0乙 \t\r\n\t \r\n丙\t\r \u00a0\n丁 \t', '甲 乙\n丙\n丁'],
  ['case and inline spacing', ' \tMiXeD  Case\tInside\u00a0Space \t\r\n\u00a0\t\rNext  LINE\t \n ', 'MiXeD  Case\tInside Space\nNext  LINE'],
  ['already normalized', 'Ab  Cd\tEf\nGh', 'Ab  Cd\tEf\nGh'],
  ['whitespace only', '\u00a0\r\n \t\r\n', ''],
];

for (const [name, input, expected] of cases) {
  test(`normalization preserves content: ${name}`, () => {
    const result = normalizedMessageText(input);
    assert.equal(result, expected);
    assert.equal(normalizedMessageText(result), result, 'normalization is idempotent');
  });
}
