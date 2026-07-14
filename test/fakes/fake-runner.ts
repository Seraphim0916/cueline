import type { JobStatus } from "../../src/jobs/status.js";
import type { RunnerSpec } from "../../src/runners/runner-adapter.js";

export class FakeJobSupervisor {
  readonly starts: RunnerSpec[] = [];
  readonly waits: string[] = [];
  readonly inspections: string[] = [];
  readonly #startResults: JobStatus[];
  readonly #completionResults: Map<string, JobStatus>;

  constructor(startResults: JobStatus[], completionResults: JobStatus[] = []) {
    this.#startResults = structuredClone(startResults);
    this.#completionResults = new Map(
      completionResults.map((status) => [status.jobId, structuredClone(status)]),
    );
  }

  async start(spec: RunnerSpec): Promise<JobStatus> {
    this.starts.push(structuredClone(spec));
    const result = this.#startResults.shift();
    if (!result) throw new Error("FAKE_RUNNER_EXHAUSTED");
    return structuredClone(result);
  }

  async waitForCompletion(jobId: string): Promise<JobStatus> {
    this.waits.push(jobId);
    const result = this.#completionResults.get(jobId);
    if (!result) throw new Error(`FAKE_COMPLETION_MISSING: ${jobId}`);
    return structuredClone(result);
  }

  async inspect(jobId: string): Promise<JobStatus> {
    this.inspections.push(jobId);
    const result = this.#completionResults.get(jobId);
    if (!result) throw new Error(`FAKE_INSPECTION_MISSING: ${jobId}`);
    return structuredClone(result);
  }
}
