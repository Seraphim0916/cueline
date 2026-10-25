import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";

import { CueLineError } from "../../dist/src/core/errors.js";
import { materializeRunnerSpec } from "../../dist/src/router/materialize.js";

const job = { job_key: "j", lane: "l", mode: "advise", task: "review this task", workdir: tmpdir() };
const route = (taskInput, args) => ({
  lane: "l",
  candidateIndex: 0,
  candidate: { id: "c", task_input: taskInput, argv: ["never-start-provider", ...args] },
});

for (const [name, args] of [
  ["standalone", ["{task}"]],
  ["embedded", ["--task={task}"]],
  ["repeated arguments", ["{task}", "--task={task}"]],
  ["repeated in one argument", ["prefix={task}:{task}:suffix"]],
]) {
  test(`stdin rejects ${name} task placeholders with route diagnostics`, () => {
    assert.throws(() => materializeRunnerSpec("job-1", job, route("stdin", args)), (error) => {
      assert.ok(error instanceof CueLineError);
      assert.equal(error.code, "ROUTE_TEMPLATE_TASK_DUPLICATE");
      assert.deepEqual(error.details, { lane: "l", candidate: "c" });
      return true;
    });
  });
}

test("stdin without a task placeholder delivers the task only through stdin", () => {
  const spec = materializeRunnerSpec("job-1", job, route("stdin", ["--stdin", "--lane={lane}"]));
  assert.deepEqual(spec.argv, ["never-start-provider", "--stdin", "--lane=l"]);
  assert.equal(spec.stdin, job.task);
  assert.equal(spec.lane, "l");
  assert.equal(spec.runnerId, "c");
});

test("argv mode accepts task placeholders without adding stdin", () => {
  const spec = materializeRunnerSpec("job-1", job, route("argv", ["{task}", "--task={task}"]));
  assert.deepEqual(spec.argv, ["never-start-provider", job.task, `--task=${job.task}`]);
  assert.equal(Object.hasOwn(spec, "stdin"), false);
});
