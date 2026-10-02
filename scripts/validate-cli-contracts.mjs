#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { main } from "../dist/src/cli/main.js";
import { cliJsonContracts, offlineGaps } from "./lib/cli-json-contracts.mjs";
import { createCliContractFixture } from "./lib/cli-contract-fixture.mjs";

async function invoke(args, environment) {
  const stdout = [];
  const stderr = [];
  const exitCode = await main(args, environment, {
    stdout: line => stdout.push(line), stderr: line => stderr.push(line),
  });
  if (stdout.length !== 1 || stderr.length !== 0) {
    throw new Error(`CLI contract did not emit one clean JSON document (exit ${exitCode}): ${stderr.join("\n")}`);
  }
  return { exitCode, value: JSON.parse(stdout[0]) };
}

export const validatedContracts = cliJsonContracts.filter(c => !offlineGaps.includes(c.command));

export async function validateCliContracts() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const fixture = await createCliContractFixture(root);
  const results = [];
  try {
    for (const contract of validatedContracts) {
      let exitCode = 1;
      try {
        const schema = JSON.parse(await readFile(`${root}/schemas/${contract.schema}`, "utf8"));
        const validate = ajv.compile(schema);
        const args = fixture.argumentsByCommand[contract.command];
        if (!args) throw new Error(`Missing offline fixture arguments: ${contract.command}`);
        const invocation = await invoke([...contract.command.split(" "), ...args, "--json"], fixture.environment);
        exitCode = invocation.exitCode;
        const valid = validate(invocation.value);
        if (!valid) console.error(`${contract.id}: ${JSON.stringify(validate.errors)}`);
        results.push({ id: contract.id, valid, exitCode });
      } catch (error) {
        console.error(`${contract.id}: ${error.message}`);
        results.push({ id: contract.id, valid: false, exitCode });
      }
    }
  } finally {
    await fixture.cleanup();
  }
  const passed = results.filter(result => result.valid).length;
  return { schema: "cueline-cli-contract-validation/1",
    status: passed === results.length ? "passed" : "failed", total: results.length,
    passed, failed: results.length - passed, commands: results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await validateCliContracts();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "passed" ? 0 : 1;
}
