import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = fileURLToPath(new URL("../../src/cli/main.js", import.meta.url));

interface Invocation {
  status: number | null;
  stdout: string;
  stderr: string;
}

function invoke(args: string[], environment: NodeJS.ProcessEnv): Invocation {
  const result = spawnSync(process.execPath, [cli, ...args], {
    env: environment,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

async function fixture(): Promise<{ config: string; home: string; environment: NodeJS.ProcessEnv }> {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-cli-"));
  const config = path.join(directory, "routing.json");
  const home = path.join(directory, "home");
  await writeFile(
    config,
    `${JSON.stringify({
      version: 1,
      lanes: {
        default: {
          enabled: true,
          candidates: [
            {
              id: "node",
              argv: [process.execPath, "-e", "process.stdout.write('ok')"],
              task_input: "stdin",
            },
          ],
        },
      },
    })}\n`,
    "utf8",
  );
  return {
    config,
    home,
    environment: { ...process.env, CUELINE_CONFIG: config, CUELINE_HOME: home },
  };
}

test("config path prints the effective configuration path", async () => {
  const context = await fixture();
  const result = invoke(["config", "path"], context.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), context.config);
});

test("routing reports the pre-spawn resolved candidate", async () => {
  const context = await fixture();
  const result = invoke(["routing"], context.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^default\s+node\s+available$/m);
});

test("doctor validates config, home, Node, and at least one route", async () => {
  const context = await fixture();
  const result = invoke(["doctor"], context.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CueLine 0\.1\.0/);
  assert.match(result.stdout, /status\s+ok/);
  assert.match(result.stdout, new RegExp(context.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("jobs is read-only and reports an empty store", async () => {
  const context = await fixture();
  const result = invoke(["jobs"], context.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No jobs\./);
});

test("help lists every command, the environment, and the exit codes", async () => {
  const context = await fixture();

  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    const result = invoke(args, context.environment);

    assert.equal(result.status, 0, result.stderr);
    for (const command of ["doctor", "routing", "jobs", "config path", "version"]) {
      assert.match(result.stdout, new RegExp(`^\\s+${command}\\s{2,}\\S`, "m"));
    }
    assert.match(result.stdout, /CUELINE_HOME/);
    assert.match(result.stdout, /CUELINE_CONFIG/);
    assert.match(result.stdout, /exit codes:/);
  }
});

test("version prints the package version alone", async () => {
  const context = await fixture();

  for (const args of [["version"], ["--version"], ["-v"]]) {
    const result = invoke(args, context.environment);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "0.1.0");
  }
});

test("an unrecognized command explains itself and exits with a usage code", async () => {
  const context = await fixture();
  const result = invoke(["lint"], context.environment);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unrecognized command: lint/);
  assert.match(result.stderr, /usage: cueline/);
  assert.match(result.stderr, /cueline help/);
});
