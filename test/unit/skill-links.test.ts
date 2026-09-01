import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
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
