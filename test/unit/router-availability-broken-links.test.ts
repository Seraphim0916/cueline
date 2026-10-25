import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executableAvailability, findExecutable } from "../../src/router/availability.js";

for (const kind of ["broken", "loop"] as const) {
  test(`${kind} symlink is unavailable directly and PATH continues to a valid executable`, async (t) => {
    if (process.platform === "win32") {
      t.skip("Creating symlinks can require Windows developer privileges");
      return;
    }
    const root = await mkdtemp(path.join(tmpdir(), "cueline-broken-links-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const first = path.join(root, "first");
    const later = path.join(root, "later");
    await mkdir(first);
    await mkdir(later);
    const link = path.join(first, "worker");
    if (kind === "broken") {
      await symlink("missing-target", link);
    } else {
      await symlink("worker-peer", link);
      await symlink("worker", path.join(first, "worker-peer"));
    }
    const valid = path.join(later, "worker");
    // Lookup only checks metadata; this fixture must never be executed.
    await writeFile(valid, "executable fixture, not a program\n", "utf8");
    await chmod(valid, 0o755);

    assert.equal(findExecutable(link, { PATH: later }), undefined);
    assert.equal(findExecutable("./first/worker", { PATH: later }, root), undefined);
    assert.equal(findExecutable("worker", { PATH: first }), undefined);
    assert.equal(executableAvailability({ PATH: later }).isAvailable(
      { id: kind, argv: [link] }, "test",
    ), false);

    const environment = { PATH: [first, later].join(path.delimiter) };
    assert.equal(findExecutable("worker", environment), valid);
    assert.equal(executableAvailability(environment).isAvailable(
      { id: kind, argv: ["worker"] }, "test",
    ), true);
  });
}
