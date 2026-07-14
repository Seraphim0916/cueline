import { CueLineError } from "../core/errors.js";

export interface JobLock {
  release(): void;
}

/** Prevents concurrent duplicate spawns for the same deterministic job id. */
export class JobLocks {
  readonly #active = new Set<string>();

  acquire(jobId: string): JobLock {
    if (this.#active.has(jobId)) {
      throw new CueLineError("JOB_ALREADY_RUNNING", `job is already running: ${jobId}`, {
        details: { jobId },
      });
    }
    this.#active.add(jobId);
    let released = false;

    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#active.delete(jobId);
      },
    };
  }
}
