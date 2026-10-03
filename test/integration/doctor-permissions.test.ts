import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const cli = fileURLToPath(new URL("../../src/cli/main.js", import.meta.url));

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-doctor-perms-"));
  const home = path.join(directory, "home");
  const config = path.join(directory, "routing.json");
  await writeFile(config, JSON.stringify({
    version: 1,
    lanes: {
      default: {
        enabled: true,
        candidates: [{ id: "node", argv: [process.execPath, "--version"], task_input: "stdin" }],
      },
    },
  }));
  return { home, environment: { ...process.env, CUELINE_HOME: home, CUELINE_CONFIG: config } };
}

async function doctor(environment: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [cli, "doctor", "--json"], {
    env: environment,
    encoding: "utf8",
  });
  assert.equal(result.stderr, "");
  assert.equal(result.error, undefined);
  const report = JSON.parse(result.stdout) as {
    status: string;
    findings: { code: string; surface: string; message: string }[];
  };
  const schema = JSON.parse(await readFile(path.join(root, "schemas/cli-doctor.schema.json"), "utf8"));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
  return { report, exitCode: result.status };
}

test("doctor warns about 0755 state home without changing readiness or exit code", async () => {
  const context = await fixture();
  await mkdir(context.home, { mode: 0o700 });
  await chmod(context.home, 0o700);
  const privateResult = await doctor(context.environment);
  assert.equal(privateResult.report.status, "ok");
  assert.equal(privateResult.exitCode, 0);
  assert.equal(privateResult.report.findings.some((item) => item.code === "STATE_HOME_PERMISSIONS_UNSAFE"), false);
  await chmod(context.home, 0o755);
  const unsafeResult = await doctor(context.environment);
  const finding = unsafeResult.report.findings.find((item) => item.code === "STATE_HOME_PERMISSIONS_UNSAFE");
  assert.ok(finding);
  assert.equal(finding.surface, "state");
  assert.match(finding.message, /755/);
  assert.match(finding.message, /cueline upgrade preflight/);
  assert.ok(finding.message.includes(`chmod 700 ${context.home}`));
  assert.equal(unsafeResult.report.status, privateResult.report.status);
  assert.equal(unsafeResult.exitCode, privateResult.exitCode);
  assert.equal((await lstat(context.home)).mode & 0o777, 0o755);
  await chmod(context.home, 0o700);
  assert.deepEqual(await doctor(context.environment), privateResult);
});

test("doctor permission warning does not change degraded status or exit code", async () => {
  const context = await fixture();
  await writeFile(context.environment.CUELINE_CONFIG, JSON.stringify({ version: 1, lanes: {} }));
  await mkdir(context.home, { mode: 0o700 });
  const before = await doctor(context.environment);
  await chmod(context.home, 0o755);
  const after = await doctor(context.environment);
  assert.equal(before.report.status, "degraded");
  assert.equal(before.exitCode, 1);
  assert.equal(after.report.status, before.report.status);
  assert.equal(after.exitCode, before.exitCode);
  assert.ok(after.report.findings.some((item) => item.code === "STATE_HOME_PERMISSIONS_UNSAFE"));
});

test("doctor ignores missing, symlink and non-directory state homes", async () => {
  const context = await fixture();
  const target = `${context.home}-target`;
  await mkdir(target, { mode: 0o755 });
  await chmod(target, 0o755);
  for (const kind of ["missing", "symlink", "file"]) {
    const home = `${context.home}-${kind}`;
    if (kind === "symlink") await symlink(target, home);
    if (kind === "file") await writeFile(home, "fixture", { mode: 0o755 });
    const result = await doctor({ ...context.environment, CUELINE_HOME: home });
    assert.equal(result.report.status, "ok");
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.findings.some((item) => item.code === "STATE_HOME_PERMISSIONS_UNSAFE"), false);
  }
});
