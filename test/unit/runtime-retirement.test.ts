import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CueLineError } from "../../src/core/errors.js";
import {
  persistRuntimeOwnerRetirements,
  readStableRuntimeOwnerRetirementCutoffs,
  type RetirementLeaseSnapshot,
} from "../../src/state/runtime-retirement.js";
import { readRuntimeLease } from "../../src/state/runtime-lease.js";
import { runPaths } from "../../src/state/paths.js";

async function home(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cueline-runtime-retirement-"));
}

function markerDirectory(stateHome: string, runId: string): string {
  return `${runPaths(stateHome, runId).runtimeLease}.retired-owners`;
}

function ownerHash(ownerId: string): string {
  return createHash("sha256").update(ownerId).digest("hex").slice(0, 24);
}

const stableMissingLease = async (): Promise<RetirementLeaseSnapshot> => ({
  identity: "missing",
  retirements: [],
  missing: true,
});

function hasInvalidRetirementCode(error: unknown): boolean {
  return error instanceof CueLineError && error.code === "RUNTIME_OWNER_RETIREMENT_INVALID";
}

test("API-written runtime retirement evidence round-trips", async () => {
  const stateHome = await home();
  const runId = "run_valid_retirement";
  await persistRuntimeOwnerRetirements(stateHome, runId, [
    {
      owner_id: "owner-valid",
      events_after_sequence: 17,
      retired_at: "2026-07-15T00:00:00.000Z",
    },
  ]);

  const cutoffs = await readStableRuntimeOwnerRetirementCutoffs(
    stateHome,
    runId,
    stableMissingLease,
  );
  assert.equal(cutoffs.get("owner-valid"), 17);
});

test("malformed retirement JSON has one stable record error", async () => {
  const stateHome = await home();
  const runId = "run_malformed_retirement";
  const directory = markerDirectory(stateHome, runId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "broken.json"), "{bad", "utf8");

  await assert.rejects(
    readStableRuntimeOwnerRetirementCutoffs(stateHome, runId, stableMissingLease),
    hasInvalidRetirementCode,
  );
});

test("runtime retirement markers reject unknown fields and noncanonical time", async () => {
  const runId = "run_invalid_retirement_shape";
  const invalidRecords = [
    {
      protocol: "cueline/runtime-owner-retirement/0.1",
      run_id: runId,
      owner_id: "owner-shape",
      events_after_sequence: 2,
      retired_at: "yesterday",
    },
    {
      protocol: "cueline/runtime-owner-retirement/0.1",
      run_id: runId,
      owner_id: "owner-shape",
      events_after_sequence: 2,
      retired_at: "2026-07-15T00:00:00.000Z",
      extra: true,
    },
  ];

  for (const record of invalidRecords) {
    const stateHome = await home();
    const directory = markerDirectory(stateHome, runId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(
        directory,
        `${ownerHash(record.owner_id)}-00000000-0000-4000-8000-000000000000.json`,
      ),
      `${JSON.stringify(record)}\n`,
      "utf8",
    );
    await assert.rejects(
      readStableRuntimeOwnerRetirementCutoffs(stateHome, runId, stableMissingLease),
      hasInvalidRetirementCode,
    );
  }
});

test("runtime retirement filename must match the owner identity", async () => {
  const stateHome = await home();
  const runId = "run_mismatched_retirement_owner";
  const directory = markerDirectory(stateHome, runId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(
      directory,
      `${ownerHash("owner-path")}-00000000-0000-4000-8000-000000000000.json`,
    ),
    `${JSON.stringify({
      protocol: "cueline/runtime-owner-retirement/0.1",
      run_id: runId,
      owner_id: "owner-body",
      events_after_sequence: 3,
      retired_at: "2026-07-15T00:00:00.000Z",
    })}\n`,
    "utf8",
  );

  await assert.rejects(
    readStableRuntimeOwnerRetirementCutoffs(stateHome, runId, stableMissingLease),
    hasInvalidRetirementCode,
  );
});

test("invalid retirement evidence is rejected before persistence", async () => {
  for (const retirement of [
    {
      owner_id: "",
      events_after_sequence: 1,
      retired_at: "2026-07-15T00:00:00.000Z",
    },
    {
      owner_id: "owner-invalid-time",
      events_after_sequence: 1,
      retired_at: "not-a-time",
    },
  ]) {
    await assert.rejects(
      persistRuntimeOwnerRetirements(
        await home(),
        "run_reject_invalid_retirement_write",
        [retirement],
      ),
      hasInvalidRetirementCode,
    );
  }
});

test("a retirement batch is fully validated before any marker is persisted", async () => {
  const stateHome = await home();
  const runId = "run_reject_partial_retirement_batch";

  await assert.rejects(
    persistRuntimeOwnerRetirements(stateHome, runId, [
      {
        owner_id: "owner-valid-first",
        events_after_sequence: 1,
        retired_at: "2026-07-15T00:00:00.000Z",
      },
      {
        owner_id: "owner-invalid-second",
        events_after_sequence: 2,
        retired_at: "not-a-time",
      },
    ]),
    hasInvalidRetirementCode,
  );

  const cutoffs = await readStableRuntimeOwnerRetirementCutoffs(
    stateHome,
    runId,
    stableMissingLease,
  );
  assert.equal(cutoffs.size, 0);
});

test("an embedded invalid retirement makes the authoritative lease invalid", async () => {
  const stateHome = await home();
  const runId = "run_invalid_embedded_retirement";
  const target = runPaths(stateHome, runId).runtimeLease;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "owner-current",
      pid: "999999",
      state: "released",
      claimed_at: "2026-07-15T00:00:00.000Z",
      heartbeat_at: "2026-07-15T00:00:00.000Z",
      released_at: "2026-07-15T00:00:00.000Z",
      retired_owners: [
        {
          owner_id: "owner-retired",
          events_after_sequence: 4,
          retired_at: "not-a-time",
        },
      ],
    })}\n`,
    "utf8",
  );

  assert.equal((await readRuntimeLease(stateHome, runId)).ownership, "invalid");
});
