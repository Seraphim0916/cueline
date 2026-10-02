import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const inventoryModule = path.join(root, "scripts/lib/cli-json-contracts.mjs");
const validatorModule = path.join(root, "scripts/validate-cli-contracts.mjs");
const { cliJsonContracts, discoverJsonCommands, offlineGaps } = await import(inventoryModule);
const { validatedContracts, validateCliContracts } = await import(validatorModule);
const sorted = (values: string[]) => [...values].sort();

test("every JSON parser path has exactly one packaged schema and offline contract", async () => {
  const discovered: Array<{ command: string; source: string }> = await discoverJsonCommands(root);
  const declared = cliJsonContracts.map((c: { command: string }) => c.command);
  assert.equal(new Set(declared).size, declared.length, "duplicate command contract");
  assert.deepEqual(sorted(discovered.map(c => c.command)), sorted(declared));
  const schemaFiles = (await readdir(path.join(root, "schemas")))
    .filter(name => /^cli-.*\.schema\.json$/.test(name));
  assert.deepEqual(sorted(schemaFiles),
    sorted(cliJsonContracts.map((c: { schema: string }) => c.schema)));
  // Explicit, commented offlineGaps is the only allowed validator exemption.
  assert.deepEqual(sorted([...validatedContracts.map((c: { command: string }) => c.command),
    ...offlineGaps]), sorted(declared));
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.ok(manifest.files.includes("schemas"), "schema directory must remain packaged");
});

test("inventory detects new JSON parsers and aliases, ignoring usage-only mentions", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "cueline-parser-coverage-"));
  try {
    await mkdir(path.join(temporaryRoot, "src/cli"), { recursive: true });
    await writeFile(path.join(temporaryRoot, "src/cli/new.ts"), `
      const usage = "cueline imaginary [--json]";
      if (args[0] === "new" && (args.length === 1 || args[1] === "--json")) {}
      if (args[0] === "run" && (args[1] === "cancel" || args[1] === "stop")) {
        if (args[3] === "--json") stdout(JSON.stringify(result));
      }
    `);
    const discovered: Array<{ command: string }> = await discoverJsonCommands(temporaryRoot);
    assert.deepEqual(sorted(discovered.map(c => c.command)), ["new", "run cancel", "run stop"]);
    const existing = new Set(cliJsonContracts.map((c: { command: string }) => c.command));
    assert.equal(existing.has("new"), false, "a new parser must not silently inherit a schema");
    await writeFile(path.join(temporaryRoot, "src/cli/unsupported.ts"),
      'const acceptsJson = args.includes("--json");');
    await assert.rejects(discoverJsonCommands(temporaryRoot), /Unmapped --json parser/,
      "an unrecognized parser form must fail closed instead of disappearing from inventory");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("all declared offline contracts validate real main() output in an isolated home", async () => {
  const report = await validateCliContracts();
  assert.deepEqual(Object.keys(report).sort(),
    ["schema", "status", "total", "passed", "failed", "commands"].sort());
  assert.equal(report.total, validatedContracts.length);
  assert.equal(report.failed, 0, JSON.stringify(report.commands));
  assert.equal(report.passed, report.total);
  assert.equal(report.status, "passed");
  assert.deepEqual(sorted(report.commands.map((c: { id: string }) => c.id)),
    sorted(validatedContracts.map((c: { id: string }) => c.id)));
});
