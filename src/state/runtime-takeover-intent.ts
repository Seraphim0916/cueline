import { randomUUID } from "node:crypto";

import { atomicWriteJson } from "./atomic-write.js";
import { ensurePrivateDirectory } from "./private-directory.js";
import { runPaths } from "./paths.js";

const TAKEOVER_INTENT_PROTOCOL = "cueline/runtime-takeover-intent/0.1";

interface RuntimeTakeoverIntentRecord {
  protocol: typeof TAKEOVER_INTENT_PROTOCOL;
  run_id: string;
  expected_owner_id: string;
  expected_heartbeat_at: string;
  requested_at: string;
  operator_confirmation: true;
}

export async function persistRuntimeTakeoverIntent(
  home: string,
  runId: string,
  expectedOwnerId: string,
  expectedHeartbeatAt: string,
  requestedAt: string,
): Promise<void> {
  const directory = `${runPaths(home, runId).runtimeLease}.takeover-intents`;
  await ensurePrivateDirectory(directory);
  await atomicWriteJson(
    `${directory}/${requestedAt.replace(/[^0-9A-Za-z]/g, "-")}-${randomUUID()}.json`,
    {
      protocol: TAKEOVER_INTENT_PROTOCOL,
      run_id: runId,
      expected_owner_id: expectedOwnerId,
      expected_heartbeat_at: expectedHeartbeatAt,
      requested_at: requestedAt,
      operator_confirmation: true,
    } satisfies RuntimeTakeoverIntentRecord,
  );
}
