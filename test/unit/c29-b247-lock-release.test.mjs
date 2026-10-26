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
let JobLocks;
try {
  ({ JobLocks } = await import('../../src/jobs/locks.ts'));
} finally {
  hooks.deregister();
}

test('releasing A again preserves B and locks for other jobs', () => {
  const locks = new JobLocks();
  const a = locks.acquire('same-job');
  const other = locks.acquire('other-job');
  a.release();
  const b = locks.acquire('same-job');
  a.release();
  a.release();
  assert.throws(() => locks.acquire('same-job'), { code: 'JOB_ALREADY_RUNNING' });
  assert.throws(() => locks.acquire('other-job'), { code: 'JOB_ALREADY_RUNNING' });
  other.release();
  const otherAgain = locks.acquire('other-job');
  assert.throws(() => locks.acquire('same-job'), { code: 'JOB_ALREADY_RUNNING' });
  b.release();
  assert.throws(() => locks.acquire('other-job'), { code: 'JOB_ALREADY_RUNNING' });
  const reacquired = locks.acquire('same-job');
  assert.throws(() => locks.acquire('same-job'), { code: 'JOB_ALREADY_RUNNING' });
  reacquired.release();
  otherAgain.release();
  console.log('old release: JOB_ALREADY_RUNNING; B release: reacquire ok');
});
