import { mkdir, open, stat } from "node:fs/promises";
import path from "node:path";

import { CueLineError } from "../core/errors.js";
import { canonicalJson } from "../core/ids.js";
import { runtimePlatform } from "../core/runtime.js";
import { atomicWriteJson } from "./atomic-write.js";
import {
  appendEvent,
  createEventLog,
  readEvents,
  type RunEvent,
} from "./event-log.js";
import { runPaths, type RunPaths } from "./paths.js";
import {
  readRuntimeLease,
  readRuntimeOwnerRetirementCutoffs,
  withRuntimeLeaseMutation,
} from "./runtime-lease.js";

export const STATE_PROTOCOL = "cueline/state/0.3";

export type RunReducer<State> = (state: State, event: RunEvent) => State;

export interface RunStoreOptions<State> {
  home: string;
  runId: string;
  initialState: State;
  reducer: RunReducer<State>;
  now?: () => Date;
}

interface StoredSnapshot<State> {
  protocol: typeof STATE_PROTOCOL;
  run_id: string;
  last_sequence: number;
  state: State;
}

function clone<State>(value: State): State {
  return structuredClone(value);
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (runtimePlatform() === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function runAlreadyExists(runId: string, cause?: unknown): Error {
  return new Error(
    `RUN_ALREADY_EXISTS: '${runId}'`,
    cause === undefined ? undefined : { cause },
  );
}

export interface RunStoreAppendOptions {
  /**
   * Only operator-intent events written immediately before an exact stale
   * takeover may bypass active-owner binding. They remain unowned and cannot
   * masquerade as work performed by either runtime.
   */
  allowUnownedRuntime?: boolean;
}

function eventIsAuthoritative(
  event: RunEvent,
  retirementCutoffs: ReadonlyMap<string, number>,
): boolean {
  const ownerId = event.runtime_owner_id;
  if (ownerId === undefined) return true;
  const cutoff = retirementCutoffs.get(ownerId);
  return cutoff === undefined || event.sequence <= cutoff;
}

export async function readAuthoritativeRunEvents(
  home: string,
  runId: string,
): Promise<RunEvent[]> {
  const paths = runPaths(home, runId);
  const [events, retirementCutoffs] = await Promise.all([
    readEvents(paths.events),
    readRuntimeOwnerRetirementCutoffs(home, runId),
  ]);
  return events.filter((event) => eventIsAuthoritative(event, retirementCutoffs));
}

export class RunStore<State> {
  readonly paths: RunPaths;
  readonly runId: string;
  readonly #initialState: State;
  readonly #reducer: RunReducer<State>;
  readonly #now: () => Date;
  readonly #home: string;
  #state: State;
  #lastSequence: number;
  #runtimeOwnerId: string | undefined;
  #appendQueue: Promise<void> = Promise.resolve();

  private constructor(
    options: RunStoreOptions<State>,
    state: State,
    lastSequence: number,
  ) {
    this.runId = options.runId;
    this.#home = options.home;
    this.paths = runPaths(options.home, options.runId);
    this.#initialState = clone(options.initialState);
    this.#reducer = options.reducer;
    this.#now = options.now ?? (() => new Date());
    this.#state = clone(state);
    this.#lastSequence = lastSequence;
  }

  static async create<State>(options: RunStoreOptions<State>): Promise<RunStore<State>> {
    const paths = runPaths(options.home, options.runId);
    const created = await mkdir(paths.runDir, { recursive: true });
    if (created !== undefined) {
      await syncDirectory(path.dirname(created));
    }
    if (await pathExists(`${paths.events}.segments`)) {
      throw runAlreadyExists(options.runId);
    }
    const existing = await readEvents(paths.events);
    if (existing.length > 0 || (await pathExists(paths.creationMarker))) {
      throw runAlreadyExists(options.runId);
    }
    let marker;
    try {
      marker = await open(paths.creationMarker, "wx", 0o600);
      await marker.writeFile(`${options.runId}\n`, "utf8");
      await marker.sync();
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw runAlreadyExists(options.runId, error);
      }
      throw error;
    } finally {
      await marker?.close();
    }
    await syncDirectory(paths.runDir);
    return new RunStore(options, options.initialState, 0);
  }

  static async createWithInitialEvent<State>(
    options: RunStoreOptions<State>,
    type: string,
    payload: unknown,
  ): Promise<RunStore<State>> {
    if (type.trim() === "") throw new Error("EVENT_TYPE_INVALID");
    const paths = runPaths(options.home, options.runId);
    if (
      (await pathExists(paths.creationMarker)) ||
      (await pathExists(`${paths.events}.segments`))
    ) {
      throw runAlreadyExists(options.runId);
    }
    const candidate: RunEvent = {
      sequence: 1,
      timestamp: (options.now ?? (() => new Date()))().toISOString(),
      type,
      payload,
    };
    let event = candidate;
    let createdEvent = false;
    try {
      await createEventLog(paths.events, candidate);
      createdEvent = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await readEvents(paths.events);
      if (
        existing.length !== 1 ||
        existing[0]?.sequence !== 1 ||
        existing[0].type !== type ||
        canonicalJson(existing[0].payload) !== canonicalJson(payload) ||
        (await pathExists(`${paths.events}.segments`))
      ) {
        throw runAlreadyExists(options.runId, error);
      }
      // Exact first-event/no-marker recovery is the sole safe recovery case.
      // The exclusive marker below elects one winner among concurrent callers.
      event = existing[0];
    }
    let marker;
    try {
      marker = await open(paths.creationMarker, "wx", 0o600);
      await marker.writeFile(`${options.runId}\n`, "utf8");
      await marker.sync();
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw runAlreadyExists(options.runId, error);
      }
      throw error;
    } finally {
      await marker?.close();
    }
    await syncDirectory(paths.runDir);
    if (!createdEvent && (await pathExists(`${paths.events}.segments`))) {
      // A segmented writer raced the recovery window. The marker is durable,
      // but this caller must not claim that it safely created the run.
      throw runAlreadyExists(options.runId);
    }
    return new RunStore(options, options.reducer(clone(options.initialState), event), 1);
  }

  static async load<State>(options: RunStoreOptions<State>): Promise<RunStore<State>> {
    const paths = runPaths(options.home, options.runId);
    const events = await readEvents(paths.events);
    const retirementCutoffs = await readRuntimeOwnerRetirementCutoffs(
      options.home,
      options.runId,
    );
    let state = clone(options.initialState);
    let lastSequence = 0;
    for (const event of events) {
      if (eventIsAuthoritative(event, retirementCutoffs)) {
        state = options.reducer(state, event);
      }
      lastSequence = event.sequence;
    }
    return new RunStore(options, state, lastSequence);
  }

  get state(): State {
    return clone(this.#state);
  }

  get lastSequence(): number {
    return this.#lastSequence;
  }

  bindRuntimeOwner(ownerId: string): void {
    if (ownerId.trim() === "") {
      throw new CueLineError(
        "EVENT_RUNTIME_OWNER_INVALID",
        "A RunStore runtime owner ID must be non-empty.",
      );
    }
    if (this.#runtimeOwnerId !== undefined && this.#runtimeOwnerId !== ownerId) {
      throw new CueLineError(
        "EVENT_RUNTIME_OWNER_REBIND_REFUSED",
        `Run '${this.runId}' store is already bound to another runtime owner.`,
      );
    }
    this.#runtimeOwnerId = ownerId;
  }

  async #runtimeWriteEvidence(
    options: RunStoreAppendOptions,
  ): Promise<Map<string, number>> {
    const retirementCutoffs = await readRuntimeOwnerRetirementCutoffs(
      this.#home,
      this.runId,
    );
    if (
      this.#runtimeOwnerId !== undefined &&
      retirementCutoffs.has(this.#runtimeOwnerId)
    ) {
      throw new CueLineError(
        "EVENT_RUNTIME_OWNER_RETIRED",
        `Run '${this.runId}' runtime owner was retired and cannot append events.`,
      );
    }
    const runtime = await readRuntimeLease(this.#home, this.runId);
    if (runtime.ownership === "invalid") {
      if (this.#runtimeOwnerId === undefined) {
        throw new CueLineError(
          "RUNTIME_LEASE_INVALID",
          `Run '${this.runId}' has unreadable runtime ownership evidence.`,
        );
      }
      // A lease holder that already proved ownership may still append its
      // bounded, owner-tagged cleanup evidence after heartbeat corruption.
      // New/unbound writers remain locked out, and a later exact takeover can
      // retire every post-cutoff event from this owner if needed.
      return retirementCutoffs;
    }
    if (runtime.ownership === "active" || runtime.ownership === "stale") {
      if (this.#runtimeOwnerId === undefined) {
        if (options.allowUnownedRuntime !== true) {
          throw new CueLineError(
            "EVENT_RUNTIME_OWNER_REQUIRED",
            `Run '${this.runId}' has an active runtime; bind its exact owner before appending.`,
          );
        }
      } else if (runtime.ownerId !== this.#runtimeOwnerId) {
        throw new CueLineError(
          "EVENT_RUNTIME_OWNER_LOST",
          `Run '${this.runId}' is now owned by another runtime.`,
        );
      }
    } else if (this.#runtimeOwnerId !== undefined) {
      throw new CueLineError(
        "EVENT_RUNTIME_OWNER_LOST",
        `Run '${this.runId}' no longer has the runtime owner bound to this store.`,
      );
    }
    return retirementCutoffs;
  }

  #rebuild(events: readonly RunEvent[], retirementCutoffs: ReadonlyMap<string, number>): void {
    let state = clone(this.#initialState);
    let lastSequence = 0;
    for (const event of events) {
      if (eventIsAuthoritative(event, retirementCutoffs)) {
        state = this.#reducer(state, event);
      }
      lastSequence = event.sequence;
    }
    this.#state = state;
    this.#lastSequence = lastSequence;
  }

  async append(
    type: string,
    payload: unknown,
    options: RunStoreAppendOptions = {},
  ): Promise<RunEvent> {
    if (type.trim() === "") {
      throw new Error("EVENT_TYPE_INVALID");
    }
    const appendUnderCurrentEvidence = async (): Promise<RunEvent> => {
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        const retirementCutoffs = await this.#runtimeWriteEvidence(options);
        const latest = await readEvents(this.paths.events);
        if (latest.length < this.#lastSequence) {
          throw new Error("EVENT_LOG_REWOUND");
        }
        this.#rebuild(latest, retirementCutoffs);
        const event: RunEvent = {
          sequence: latest.length + 1,
          timestamp: this.#now().toISOString(),
          type,
          payload,
          ...(this.#runtimeOwnerId === undefined
            ? {}
            : { runtime_owner_id: this.#runtimeOwnerId }),
        };
        try {
          await appendEvent(this.paths.events, event);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "EVENT_SEQUENCE_CONFLICT"
          ) {
            continue;
          }
          throw error;
        }
        // A takeover may complete after the pre-append check. The immutable
        // event remains auditable, but the retirement cutoff makes it
        // non-authoritative and this writer must not report success.
        const postAppendCutoffs = await this.#runtimeWriteEvidence(options);
        if (!eventIsAuthoritative(event, postAppendCutoffs)) {
          throw new CueLineError(
            "EVENT_RUNTIME_OWNER_RETIRED",
            `Run '${this.runId}' runtime owner was retired while appending.`,
          );
        }
        this.#state = this.#reducer(this.#state, event);
        this.#lastSequence = event.sequence;
        return event;
      }
      throw new Error("EVENT_SEQUENCE_CONTENTION_EXHAUSTED");
    };
    const operation = this.#appendQueue.then(() =>
      this.#runtimeOwnerId !== undefined || options.allowUnownedRuntime === true
        ? withRuntimeLeaseMutation(this.#home, this.runId, appendUnderCurrentEvidence)
        : appendUnderCurrentEvidence(),
    );
    this.#appendQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async snapshot(): Promise<void> {
    const snapshot: StoredSnapshot<State> = {
      protocol: STATE_PROTOCOL,
      run_id: this.runId,
      last_sequence: this.#lastSequence,
      state: this.#state,
    };
    await atomicWriteJson(this.paths.snapshot, snapshot);
  }

  async replay(): Promise<State> {
    let state = clone(this.#initialState);
    const retirementCutoffs = await readRuntimeOwnerRetirementCutoffs(
      this.#home,
      this.runId,
    );
    for (const event of await readEvents(this.paths.events)) {
      if (eventIsAuthoritative(event, retirementCutoffs)) {
        state = this.#reducer(state, event);
      }
    }
    return state;
  }
}
