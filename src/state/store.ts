import { mkdir, readFile } from "node:fs/promises";

import { atomicWriteJson } from "./atomic-write.js";
import { appendEvent, readEvents, type RunEvent } from "./event-log.js";
import { runPaths, type RunPaths } from "./paths.js";

const STATE_PROTOCOL = "cueline/state/0.2";

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

function parseSnapshot<State>(contents: string, runId: string): StoredSnapshot<State> {
  const parsed = JSON.parse(contents) as Partial<StoredSnapshot<State>>;
  if (
    parsed.protocol !== STATE_PROTOCOL ||
    parsed.run_id !== runId ||
    !Number.isSafeInteger(parsed.last_sequence) ||
    (parsed.last_sequence as number) < 0 ||
    parsed.state === undefined
  ) {
    throw new Error("STATE_SNAPSHOT_INVALID");
  }
  return parsed as StoredSnapshot<State>;
}

export class RunStore<State> {
  readonly paths: RunPaths;
  readonly runId: string;
  readonly #initialState: State;
  readonly #reducer: RunReducer<State>;
  readonly #now: () => Date;
  #state: State;
  #lastSequence: number;

  private constructor(
    options: RunStoreOptions<State>,
    state: State,
    lastSequence: number,
  ) {
    this.runId = options.runId;
    this.paths = runPaths(options.home, options.runId);
    this.#initialState = clone(options.initialState);
    this.#reducer = options.reducer;
    this.#now = options.now ?? (() => new Date());
    this.#state = clone(state);
    this.#lastSequence = lastSequence;
  }

  static async create<State>(options: RunStoreOptions<State>): Promise<RunStore<State>> {
    const paths = runPaths(options.home, options.runId);
    await mkdir(paths.runDir, { recursive: true });
    const existing = await readEvents(paths.events);
    if (existing.length > 0) {
      throw new Error(`RUN_ALREADY_EXISTS: '${options.runId}'`);
    }
    return new RunStore(options, options.initialState, 0);
  }

  static async load<State>(options: RunStoreOptions<State>): Promise<RunStore<State>> {
    const paths = runPaths(options.home, options.runId);
    const events = await readEvents(paths.events);
    let state = clone(options.initialState);
    let lastSequence = 0;

    try {
      const snapshot = parseSnapshot<State>(await readFile(paths.snapshot, "utf8"), options.runId);
      if (snapshot.last_sequence <= events.length) {
        state = clone(snapshot.state);
        lastSequence = snapshot.last_sequence;
      }
    } catch {
      state = clone(options.initialState);
      lastSequence = 0;
    }

    for (const event of events) {
      if (event.sequence > lastSequence) {
        state = options.reducer(state, event);
        lastSequence = event.sequence;
      }
    }
    return new RunStore(options, state, lastSequence);
  }

  get state(): State {
    return clone(this.#state);
  }

  get lastSequence(): number {
    return this.#lastSequence;
  }

  async append(type: string, payload: unknown): Promise<RunEvent> {
    if (type.trim() === "") {
      throw new Error("EVENT_TYPE_INVALID");
    }
    const event: RunEvent = {
      sequence: this.#lastSequence + 1,
      timestamp: this.#now().toISOString(),
      type,
      payload,
    };
    await appendEvent(this.paths.events, event);
    this.#state = this.#reducer(this.#state, event);
    this.#lastSequence = event.sequence;
    return event;
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
    for (const event of await readEvents(this.paths.events)) {
      state = this.#reducer(state, event);
    }
    return state;
  }
}
