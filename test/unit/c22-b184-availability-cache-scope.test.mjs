import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataUrl = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const runtime = dataUrl(await readFile(new URL('../../src/core/runtime.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../../src/router/availability.ts', import.meta.url), 'utf8');
// Replace only the filesystem boundary; retain the real lookup and cache logic.
const { executableAvailability, setFilesystem } = await import(dataUrl(source
  .replace('import { constants, accessSync, statSync } from "node:fs";',
    `import { constants } from 'node:fs';
     let accessSync, statSync;
     export const setFilesystem = fs => { ({ accessSync, statSync } = fs); };`)
  .replace('"../core/runtime.js"', JSON.stringify(runtime))));

for (const initial of [false, true]) {
  test(`${initial ? 'positive' : 'negative'} cache is per executable and per checker`, () => {
    const directory = path.join(tmpdir(), 'c22-b184-virtual-bin');
    const shared = path.join(directory, 'shared');
    const other = path.join(directory, 'other');
    const states = new Map([[shared, initial], [other, !initial]]);
    const statCalls = [];
    const accessCalls = [];
    setFilesystem({
      statSync(file) {
        statCalls.push(file);
        if (!states.get(file)) throw new Error('fixture executable missing');
        return { isFile: () => true };
      },
      accessSync(file) { accessCalls.push(file); },
    });
    const first = { id: 'first', argv: ['shared', 'one'] };
    const alias = { id: 'alias', argv: ['shared', 'two'] };
    const distinct = { id: 'first', argv: ['other'] };
    const checker = executableAvailability({ PATH: directory }, directory);
    assert.equal(checker.isAvailable(first), initial);
    assert.deepEqual(statCalls, [shared]);
    states.set(shared, !initial);
    assert.equal(checker.isAvailable(first), initial);
    assert.equal(checker.isAvailable(alias), initial);
    assert.deepEqual(statCalls, [shared], 'same executable must not be queried again');

    const fresh = executableAvailability({ PATH: directory }, directory);
    assert.equal(fresh.isAvailable(alias), !initial);
    assert.deepEqual(statCalls, [shared, shared], 'new checker must query again');
    assert.equal(checker.isAvailable(distinct), !initial);
    assert.deepEqual(statCalls, [shared, shared, other]);
    states.set(other, initial);
    assert.equal(checker.isAvailable(distinct), !initial);
    assert.deepEqual(statCalls, [shared, shared, other], 'other executable has its own cache');
    assert.deepEqual(accessCalls, initial ? [shared] : [shared, other]);
  });
}
