import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeRunnerSpec } from "../../src/router/materialize.js";

for (const delivery of ["argv", "stdin"] as const) {
  test(`materialize preserves task literals with ${delivery} delivery without execution`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "cueline-literals-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const marker = path.join(root, "must-not-exist");
    const task = [
      "{workdir} {task} {job_id} {lane} {mode} {sandbox}",
      `$(touch '${marker}') "double quotes" 'single quotes'`,
      "第二行：台灣 café 🧪 $& $` $' \\ backslash",
      "",
    ].join("\n");
    // Tokens inside replacement values must not be expanded a second time.
    const workdir = path.join(root, "{task}-{workdir}");
    const argv = delivery === "argv"
      ? ["never-start-provider", "--cwd", "{workdir}", "--task", "{task}", "prefix={task}:suffix"]
      : ["never-start-provider", "--cwd", "{workdir}", "--stdin"];
    assert.equal(existsSync(marker), false);

    const spec = materializeRunnerSpec(
      "literal-job",
      { job_key: "literal", lane: "test", mode: "advise", task, workdir },
      { lane: "test", candidateIndex: 0, candidate: { id: "literal", argv, task_input: delivery } },
    );

    assert.deepEqual(spec.argv, delivery === "argv"
      ? ["never-start-provider", "--cwd", workdir, "--task", task, `prefix=${task}:suffix`]
      : ["never-start-provider", "--cwd", workdir, "--stdin"]);
    assert.equal(spec.stdin, delivery === "stdin" ? task : undefined);
    assert.equal(spec.task, task);
    assert.equal(spec.cwd, workdir);
    assert.equal(existsSync(marker), false, "command substitution must remain inert text");
  });
}
