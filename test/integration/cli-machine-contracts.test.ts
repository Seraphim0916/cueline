import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import { main } from "../../src/cli/main.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));

async function validator(name: string): Promise<ValidateFunction> {
  const schema = JSON.parse(
    await readFile(path.join(root, "schemas", name), "utf8"),
  ) as object;
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}

async function output(
  args: string[],
  environment: NodeJS.ProcessEnv = {
    ...process.env,
    CUELINE_CONFIG: path.join(root, "config/routing.default.json"),
  },
): Promise<Record<string, unknown>> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  await main(
    args,
    environment,
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
  );
  assert.deepEqual(stderr, []);
  assert.equal(stdout.length, 1);
  return JSON.parse(stdout[0] ?? "null") as Record<string, unknown>;
}

test("doctor, routing, and routing explain conform to published schemas", async () => {
  const cases = [
    { args: ["doctor", "--json"], schema: "cli-doctor.schema.json" },
    { args: ["routing", "--json"], schema: "cli-routing.schema.json" },
    {
      args: ["routing", "explain", "--json"],
      schema: "cli-routing-explain.schema.json",
    },
  ];
  for (const candidate of cases) {
    const validate = await validator(candidate.schema);
    const value = await output(candidate.args);
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  }
});

test("contracts reject an added secret-like field and a missing required field", async () => {
  const validate = await validator("cli-doctor.schema.json");
  const value = await output(["doctor", "--json"]);
  assert.equal(validate({ ...value, token: "must-not-appear" }), false);

  const withoutFindings = { ...value };
  delete withoutFindings.findings;
  assert.equal(validate(withoutFindings), false);
});

test("routing contract rejects runner argv and wrong schema versions", async () => {
  const validate = await validator("cli-routing.schema.json");
  const value = await output(["routing", "--json"]);
  const lanes = structuredClone(value.lanes) as Array<Record<string, unknown>>;
  lanes[0] = { ...lanes[0], argv: ["secret", "argument"] };
  assert.equal(validate({ ...value, lanes }), false);
  assert.equal(validate({ ...value, schema: "cueline-routing/2" }), false);
});

test("degraded outputs from an invalid routing config still conform", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-cli-contract-invalid-"));
  const config = path.join(directory, "routing.json");
  await writeFile(config, "{invalid-routing", "utf8");
  const environment = { ...process.env, CUELINE_CONFIG: config };
  const cases = [
    { args: ["doctor", "--json"], schema: "cli-doctor.schema.json" },
    { args: ["routing", "--json"], schema: "cli-routing.schema.json" },
    {
      args: ["routing", "explain", "--json"],
      schema: "cli-routing-explain.schema.json",
    },
  ];
  for (const candidate of cases) {
    const validate = await validator(candidate.schema);
    const value = await output(candidate.args, environment);
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    assert.equal(JSON.stringify(value).includes("invalid-routing"), false);
  }
});
