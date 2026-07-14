import { CueLineError } from "../core/errors.js";

export interface RegisteredExecutable {
  id: string;
  executable: string;
}

function validateEntry(entry: RegisteredExecutable): void {
  if (entry.id.trim().length === 0) {
    throw new CueLineError("RUNNER_REGISTRY_INVALID", "registered runner id must be non-empty");
  }
  if (entry.executable.trim().length === 0) {
    throw new CueLineError("RUNNER_REGISTRY_INVALID", "registered executable must be non-empty", {
      details: { id: entry.id },
    });
  }
}

/**
 * Explicit allow-list for argv[0]. Registering an executable never grants
 * permission to invoke a shell or to substitute a different argv[0].
 */
export class RunnerRegistry {
  readonly #byId = new Map<string, RegisteredExecutable>();
  readonly #byExecutable = new Map<string, RegisteredExecutable>();

  constructor(entries: Iterable<RegisteredExecutable> = []) {
    for (const entry of entries) {
      this.register(entry);
    }
  }

  register(entry: RegisteredExecutable): this {
    validateEntry(entry);
    if (this.#byId.has(entry.id) || this.#byExecutable.has(entry.executable)) {
      throw new CueLineError("RUNNER_REGISTRY_DUPLICATE", "runner executable is already registered", {
        details: { id: entry.id, executable: entry.executable },
      });
    }

    const registered = { ...entry };
    this.#byId.set(registered.id, registered);
    this.#byExecutable.set(registered.executable, registered);
    return this;
  }

  get(id: string): RegisteredExecutable | undefined {
    return this.#byId.get(id);
  }

  hasExecutable(executable: string): boolean {
    return this.#byExecutable.has(executable);
  }

  requireExecutable(executable: string): RegisteredExecutable {
    const registered = this.#byExecutable.get(executable);
    if (registered === undefined) {
      throw new CueLineError(
        "RUNNER_EXECUTABLE_UNREGISTERED",
        `argv executable is not pre-registered: ${executable}`,
        { details: { executable } },
      );
    }
    return registered;
  }

  requireArgv(argv: readonly string[]): RegisteredExecutable {
    const executable = argv[0];
    if (typeof executable !== "string" || executable.length === 0) {
      throw new CueLineError("RUNNER_ARGV_INVALID", "argv must begin with a non-empty executable");
    }
    return this.requireExecutable(executable);
  }
}
