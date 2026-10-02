import { readFile, readdir } from "node:fs/promises";

// One entry per accepted command path, including the run stop alias.
// serialize names the CLI function containing the actual JSON.stringify input;
// api names an unwrapped public result for the inline branches of main().
export const cliJsonContracts = [
  ["doctor", "health-commands", "doctorCommand"],
  ["self-test", "diagnostics/offline-self-test", null, "runOfflineSelfTest"],
  ["upgrade preflight", "health-commands", null, "collectUpgradePreflight"],
  ["routing", "health-commands", "routingCommand"],
  ["routing explain", "health-commands", "routingExplainCommand"],
  ["jobs", "main", "jobsCommand"],
  ["protocol lint", "main", "protocolLintCommand"],
  ["runs", "observation-commands", "runsCommand"],
  ["runs prune", "main", "runsPruneCommand"],
  ["runs sweep", "main", "runsSweepCommand"],
  ["run status", "main", "runStatusCommand"],
  ["run status-at", "observation-commands", "runStatusAtCommand"],
  ["run diff", "observation-commands", "runDiffCommand"],
  ["run doctor", "observation-commands", "runDoctorCommand"],
  ["run watch", "observation-commands", "runWatchCommand"],
  ["run handoff", "observation-commands", "runHandoffCommand"],
  ["run timeline", "observation-commands", "runTimelineCommand"],
  ["run graph", "observation-commands", "runGraphCommand"],
  ["run verify", "observation-commands", "runVerifyCommand"],
  ["run audit-secrets", "observation-commands", "runAuditSecretsCommand"],
  ["run export", "observation-commands", "runExportCommand"],
  ["run reconcile", "main", null, "confirmManualControllerSubmission"],
  ["run authorize-delivery-retry", "main", null, "authorizeControllerDeliveryTimeoutRetry"],
  ["run authorize-response-retry", "main", null, "authorizeControllerResponseRetry"],
  ["run takeover", "main", null, "takeoverCueLineRuntime"],
  ["run reconcile-runtime", "main", null, "reconcileCueLineRuntime"],
  ["run cancel", "main", null, "cancelCueLineRun"],
  ["run stop", "main", null, "cancelCueLineRun"],
  ["job cancel", "main", null, "cancelCueLineJob"],
].map(([command, module, serialize, api]) => ({
  command, id: command.replaceAll(" ", "-"),
  schema: `cli-${command.replaceAll(" ", "-")}.schema.json`,
  source: module.includes("/") ? `src/${module}.ts` : `src/cli/${module}.ts`,
  serialize, api,
  needsRun: command.startsWith("run ") || command === "job cancel",
}));

// No offline omissions today. Any future exception must document its reason here
// and in PROGRESS-39-1.md; missing schemas are never exempt.
export const offlineGaps = [];

export async function discoverJsonCommands(root) {
  const commands = [];
  // Parse code, not usage strings. A command branch must compare args[0],
  // and contain the exact "--json" string literal used by its parser.
  function endOf(text, start, open, close) {
    let depth = 0;
    let quote = "";
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = "";
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) return i;
    }
    throw new Error("Unbalanced CLI parser branch");
  }
  const files = (await readdir(`${root}/src/cli`, { recursive: true }))
    .filter(file => file.endsWith(".ts"));
  for (const file of files) {
    const source = (await readFile(`${root}/src/cli/${file}`, "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const covered = [];
    for (const match of source.matchAll(/\bif\s*\(/g)) {
      const start = match.index + match[0].lastIndexOf("(");
      const end = endOf(source, start, "(", ")");
      const condition = source.slice(start, end + 1);
      const first = [...condition.matchAll(/args\[0\]\s*===\s*"([^"]+)"/g)].map(m => m[1]);
      if (!first.length) continue;
      const rest = source.slice(end + 1);
      const bodyStart = end + 1 + rest.search(/\S/);
      const bodyEnd = source[bodyStart] === "{" ? endOf(source, bodyStart, "{", "}") : bodyStart;
      const branch = source.slice(start, bodyEnd + 1);
      if (!branch.includes('"--json"')) continue;
      covered.push([start, bodyEnd]);
      const second = [...condition.matchAll(/args\[1\]\s*===\s*"([^"]+)"/g)]
        .map(m => m[1]).filter(value => !value.startsWith("--"));
      for (const a of first) for (const b of second.length ? second : [""]) {
        commands.push({ command: [a, b].filter(Boolean).join(" "), source: `src/cli/${file}` });
      }
    }
    // Fail closed if a future parser uses a different dispatch form. It must
    // teach this discovery helper its command path, not disappear from counts.
    for (const flag of source.matchAll(/"--json"/g)) {
      if (!covered.some(([start, end]) => flag.index >= start && flag.index <= end)) {
        throw new Error(`Unmapped --json parser in src/cli/${file} at offset ${flag.index}`);
      }
    }
  }
  return commands.sort((a, b) => a.command.localeCompare(b.command));
}
