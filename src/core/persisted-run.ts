import { CueLineError } from "./errors.js";
import {
  initialRunState,
  reduceRunState,
  type CueLineRunState,
} from "./state-machine.js";
import { RunStore } from "../state/store.js";

export async function loadPersistedRunStore(
  home: string,
  runId: string,
): Promise<RunStore<CueLineRunState>> {
  const store = await RunStore.load({
    home,
    runId,
    initialState: initialRunState(runId, ""),
    reducer: reduceRunState,
  });
  if (store.state.request === "") {
    throw new CueLineError("RUN_NOT_FOUND", `No persisted CueLine run '${runId}' was found.`);
  }
  return store;
}

export async function loadPersistedRunState(
  home: string,
  runId: string,
): Promise<CueLineRunState> {
  return (await loadPersistedRunStore(home, runId)).state;
}
