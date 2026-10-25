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
let timing, bridge, CueLineError;
try {
  ({ resolveClaudeDesktopIabTimingOptions: timing,
    resolveClaudeDesktopBridgeRequestTimeoutMs: bridge } =
    await import('../../src/browser/claude-desktop/lane-options.ts'));
  ({ CueLineError } = await import('../../src/core/errors.ts'));
} finally {
  hooks.deregister();
}

for (const [name, resolve, fallback] of [
  ['CUELINE_COMPOSER_READY_TIMEOUT_MS', env => timing(env).composerReadyTimeoutMs, 120_000],
  ['CUELINE_BROWSER_OPERATION_TIMEOUT_MS', env => timing(env).browserOperationTimeoutMs, 180_000],
  ['CUELINE_HOST_BRIDGE_REQUEST_TIMEOUT_MS', bridge, 120_000],
]) {
  test(`${name}: defaults and legal decimal boundaries`, () => {
    assert.equal(resolve({}), fallback);
    for (const value of ['1000', '1001', '3599999', '3600000', '001000']) {
      assert.equal(resolve({ [name]: value }), Number(value));
    }
  });
  test(`${name}: rejects whitespace, mixed text and out-of-range values with existing code`, () => {
    const invalid = ['', '999', '3600001', '-1000', '+1000', '1e3', '1000.0', '0x1000',
      '1000ms', 'a1000', '10_00', '１０００', 'NaN', 'Infinity'];
    for (const separator of ['\n', '\r', '\r\n', '\u2028', '\u2029', ' ', '\t', '\u00a0']) {
      invalid.push(`1000${separator}`, `${separator}1000`, `10${separator}00`,
        `${separator}1000${separator}`, `1000${separator}x`);
    }
    for (const value of invalid) {
      assert.throws(() => resolve({ [name]: value }), error => {
        assert.ok(error instanceof CueLineError);
        assert.equal(error.code, 'CLAUDE_DESKTOP_IAB_TIMING_OPTION_INVALID');
        assert.ok(error.message.includes(name));
        return true;
      }, JSON.stringify(value));
    }
  });
}
