#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import { main } from "../dist/src/cli/main.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const contracts = [
  { id: "doctor", args: ["doctor", "--json"], schema: "cli-doctor.schema.json" },
  { id: "routing", args: ["routing", "--json"], schema: "cli-routing.schema.json" },
  {
    id: "routing-explain",
    args: ["routing", "explain", "--json"],
    schema: "cli-routing-explain.schema.json",
  },
];

async function invoke(args, environment) {
  const stdout = [];
  const stderr = [];
  const exitCode = await main(args, environment, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  if (stdout.length !== 1 || stderr.length !== 0) {
    throw new Error("CLI contract command did not emit one clean JSON document");
  }
  return { exitCode, value: JSON.parse(stdout[0]) };
}

const environment = {
  ...process.env,
  CUELINE_CONFIG: `${root}/config/routing.default.json`,
};
const ajv = new Ajv2020({ allErrors: true, strict: true });
const results = [];
for (const contract of contracts) {
  const schema = JSON.parse(
    await readFile(`${root}/schemas/${contract.schema}`, "utf8"),
  );
  const validate = ajv.compile(schema);
  const invocation = await invoke(contract.args, environment);
  const valid = validate(invocation.value);
  results.push({ id: contract.id, valid, exitCode: invocation.exitCode });
}
const passed = results.filter((result) => result.valid).length;
const report = {
  schema: "cueline-cli-contract-validation/1",
  status: passed === results.length ? "passed" : "failed",
  total: results.length,
  passed,
  failed: results.length - passed,
  commands: results,
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "passed" ? 0 : 1;
