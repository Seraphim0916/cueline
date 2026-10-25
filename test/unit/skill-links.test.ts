import assert from "node:assert/strict";
import fs, {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { main } from "../../src/cli/main.js";
import { installSkill, uninstallSkill } from "../../src/cli/skill-links.js";

const codexSource = fileURLToPath(new URL("../../../skills/cueline", import.meta.url));
const claudeSource = fileURLToPath(new URL("../../../skills/cueline-host", import.meta.url));

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-skill-links-"));
  const codexTarget = path.join(home, ".codex", "skills", "cueline");
  const claudeTarget = path.join(home, ".claude", "skills", "cueline-host");
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    CODEX_HOME: path.join(home, ".codex"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  };
  return { home, codexTarget, claudeTarget, environment };
}

async function assertMissing(candidate: string): Promise<void> {
  await assert.rejects(readlink(candidate), { code: "ENOENT" });
}

// Root bypasses directory permission bits, so a mode-000 parent cannot yield
// EACCES there; the non-root CI runners still execute these cases.
const permissionDenialUnavailable =
  process.platform === "win32"
    ? "POSIX directory permission bits do not deny lstat on Windows"
    : process.getuid?.() === 0
      ? "running as root bypasses directory permission bits, so lstat cannot fail with EACCES"
      : false;

test("default install manages both skill links idempotently and uninstall removes them", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.home, { recursive: true, force: true }));

  await installSkill(context.environment);
  assert.equal(await readlink(context.codexTarget), codexSource);
  assert.equal(await readlink(context.claudeTarget), claudeSource);

  await installSkill(context.environment);
  assert.equal(await readlink(context.codexTarget), codexSource);
  assert.equal(await readlink(context.claudeTarget), claudeSource);

  await uninstallSkill(context.environment);
  await assertMissing(context.codexTarget);
  await assertMissing(context.claudeTarget);
});

test("scope options install and uninstall only the selected platform", async (t) => {
  for (const scope of ["codex-only", "claude-only"] as const) {
    const context = await fixture();
    t.after(() => rm(context.home, { recursive: true, force: true }));
    const stderr: string[] = [];
    const io = { stdout: () => undefined, stderr: (line: string) => stderr.push(line) };

    assert.equal(await main(["install", `--${scope}`], context.environment, io), 0);
    assert.deepEqual(stderr, []);
    if (scope === "codex-only") {
      assert.equal(await readlink(context.codexTarget), codexSource);
      await assertMissing(context.claudeTarget);
    } else {
      await assertMissing(context.codexTarget);
      assert.equal(await readlink(context.claudeTarget), claudeSource);
    }

    assert.equal(await main(["uninstall", `--${scope}`], context.environment, io), 0);
    assert.deepEqual(stderr, []);
    await assertMissing(context.codexTarget);
    await assertMissing(context.claudeTarget);
  }
});

test("foreign path aborts install without overwrite or partial links and survives uninstall", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.home, { recursive: true, force: true }));
  await mkdir(path.dirname(context.claudeTarget), { recursive: true });
  await writeFile(context.claudeTarget, "foreign\n");

  await assert.rejects(
    installSkill(context.environment),
    /refusing to replace foreign path/,
  );
  await assertMissing(context.codexTarget);
  assert.equal(await readFile(context.claudeTarget, "utf8"), "foreign\n");

  await uninstallSkill(context.environment);
  assert.equal(await readFile(context.claudeTarget, "utf8"), "foreign\n");
});

test("CLI rejects mutually exclusive install and uninstall scope flags with a named error", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.home, { recursive: true, force: true }));
  for (const command of ["install", "uninstall"] as const) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await main(
      [command, "--codex-only", "--claude-only"],
      context.environment,
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    );

    assert.equal(exitCode, 2);
    assert.deepEqual(stdout, []);
    assert.match(stderr.join("\n"), /CLI_ARGUMENTS_INVALID/);
    assert.match(stderr.join("\n"), /mutually exclusive/);
  }
  await assertMissing(context.codexTarget);
  await assertMissing(context.claudeTarget);
});

test("a regular file in place of the skills directory aborts install and uninstall untouched", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.home, { recursive: true, force: true }));
  const blocker = path.dirname(context.claudeTarget);
  await mkdir(path.dirname(blocker), { recursive: true });
  await writeFile(blocker, "not a directory\n");

  await assert.rejects(installSkill(context.environment), { code: "ENOTDIR" });
  await assertMissing(context.codexTarget);
  assert.equal(await readFile(blocker, "utf8"), "not a directory\n");

  await assert.rejects(uninstallSkill(context.environment), { code: "ENOTDIR" });
  assert.equal(await readFile(blocker, "utf8"), "not a directory\n");
});

test(
  "an unreadable skills directory aborts install without touching the foreign path",
  { skip: permissionDenialUnavailable },
  async (t) => {
    const context = await fixture();
    const parent = path.dirname(context.claudeTarget);
    t.after(async () => {
      await chmod(parent, 0o700).catch(() => undefined);
      await rm(context.home, { recursive: true, force: true });
    });
    await mkdir(parent, { recursive: true });
    await writeFile(context.claudeTarget, "foreign\n");
    await chmod(parent, 0o000);

    await assert.rejects(installSkill(context.environment), { code: "EACCES" });
    await assertMissing(context.codexTarget);

    await chmod(parent, 0o700);
    assert.equal(await readFile(context.claudeTarget, "utf8"), "foreign\n");
  },
);

test(
  "an unreadable skills directory aborts uninstall instead of reporting the link absent",
  { skip: permissionDenialUnavailable },
  async (t) => {
    const context = await fixture();
    const parent = path.dirname(context.claudeTarget);
    t.after(async () => {
      await chmod(parent, 0o700).catch(() => undefined);
      await rm(context.home, { recursive: true, force: true });
    });
    await installSkill(context.environment, "claude-only");
    await chmod(parent, 0o000);

    await assert.rejects(uninstallSkill(context.environment, "claude-only"), { code: "EACCES" });

    await chmod(parent, 0o700);
    assert.equal(await readlink(context.claudeTarget), claudeSource);
  },
);

for (const code of ["EACCES", "EPERM"] as const) {
  for (const operation of ["install", "uninstall"] as const) {
    for (const ownership of ["managed", "foreign"] as const) {
      test(`${operation} propagates ${code} from readlink after successful lstat and preserves ${ownership} symlink`, async (t) => {
        const context = await fixture();
        t.after(() => rm(context.home, { recursive: true, force: true }));
        const source = ownership === "managed" ? codexSource : path.join(context.home, "foreign-skill");
        if (ownership === "foreign") {
          await mkdir(source);
          await writeFile(path.join(source, "SKILL.md"), "foreign skill\n");
        }
        await mkdir(path.dirname(context.codexTarget), { recursive: true });
        await symlink(source, context.codexTarget, "dir");
        const before = await lstat(context.codexTarget);
        assert.ok(before.isSymbolicLink());

        const failure = Object.assign(new Error(`${code}: readlink denied`), { code });
        const readlinkMock = t.mock.method(fs, "readlink", async (candidate: string) => {
          assert.equal(candidate, context.codexTarget);
          // The actual filesystem permits lstat; only reading the link is denied.
          assert.ok((await lstat(candidate)).isSymbolicLink());
          throw failure;
        });
        syncBuiltinESMExports();
        try {
          const action = operation === "install" ? installSkill : uninstallSkill;
          await assert.rejects(action(context.environment, "codex-only"), (error) => error === failure);
          assert.equal(readlinkMock.mock.callCount(), 1);
        } finally {
          readlinkMock.mock.restore();
          syncBuiltinESMExports();
        }

        const after = await lstat(context.codexTarget);
        assert.ok(after.isSymbolicLink());
        assert.equal(after.dev, before.dev);
        assert.equal(after.ino, before.ino);
        assert.equal(await readlink(context.codexTarget), source);
        if (ownership === "foreign") {
          assert.equal(await readFile(path.join(source, "SKILL.md"), "utf8"), "foreign skill\n");
        }
        await assertMissing(context.claudeTarget);
      });
    }
  }
}

test("a foreign or dangling symlink at a target is neither replaced nor removed", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.home, { recursive: true, force: true }));
  const foreignSource = path.join(context.home, "foreign-skill");
  const danglingSource = path.join(context.home, "missing-skill");
  await mkdir(foreignSource);
  await mkdir(path.dirname(context.codexTarget), { recursive: true });
  await mkdir(path.dirname(context.claudeTarget), { recursive: true });
  await symlink(foreignSource, context.codexTarget, "dir");
  await symlink(danglingSource, context.claudeTarget, "dir");

  for (const scope of ["codex-only", "claude-only"] as const) {
    await assert.rejects(
      installSkill(context.environment, scope),
      /refusing to replace foreign path/,
    );
  }
  assert.equal(await readlink(context.codexTarget), foreignSource);
  assert.equal(await readlink(context.claudeTarget), danglingSource);

  const output = await uninstallSkill(context.environment);
  assert.ok(output.includes(`preserved foreign path: ${context.codexTarget}`), output);
  assert.ok(output.includes(`preserved foreign path: ${context.claudeTarget}`), output);
  assert.equal(await readlink(context.codexTarget), foreignSource);
  assert.equal(await readlink(context.claudeTarget), danglingSource);
});

test("a real directory at a target is neither replaced nor removed", async (t) => {
  const context = await fixture();
  t.after(() => rm(context.home, { recursive: true, force: true }));
  await mkdir(context.codexTarget, { recursive: true });
  await writeFile(path.join(context.codexTarget, "SKILL.md"), "user skill\n");

  await assert.rejects(installSkill(context.environment), /refusing to replace foreign path/);
  await assertMissing(context.claudeTarget);

  const output = await uninstallSkill(context.environment);
  assert.match(output, /preserved foreign path/);
  assert.deepEqual(await readdir(context.codexTarget), ["SKILL.md"]);
  assert.equal(await readFile(path.join(context.codexTarget, "SKILL.md"), "utf8"), "user skill\n");
});
