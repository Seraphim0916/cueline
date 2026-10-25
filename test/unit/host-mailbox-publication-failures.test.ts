import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CueLineError } from "../../src/core/errors.js";
import {
  createFileBridgeTools,
  type FileBridgeFs,
  type FileBridgeInFlightPhase,
  type FileBridgeResponse,
} from "../../src/browser/claude-desktop/file-bridge.js";
import {
  claimNextHostMailboxRequest,
  publishHostMailboxResponse,
} from "../../src/browser/claude-desktop/host-mailbox.js";

// Real disk operations: only ENOENT means absent, just as in the bridge contract.
const disk: FileBridgeFs = {
  async mkdir(directory) { await mkdir(directory, { recursive: true }); },
  async writeAtomic(path, contents) {
    await writeFile(`${path}.partial`, contents, "utf8");
    await rename(`${path}.partial`, path);
  },
  async read(path) {
    try { return await readFile(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  async remove(path) { await rm(path, { force: true }); },
  rename,
};

const failures: ReadonlyArray<{
  name: string;
  blocker: "state" | "response" | "destination";
  late?: boolean;
  phase: FileBridgeInFlightPhase;
  hasPartial: boolean;
}> = [
  { name: "action_completed state write", blocker: "state", phase: "action_started", hasPartial: false },
  { name: "response partial write", blocker: "response", phase: "action_completed", hasPartial: false },
  { name: "response_published state write", blocker: "state", late: true, phase: "action_completed", hasPartial: true },
  { name: "final response rename", blocker: "destination", phase: "response_published", hasPartial: true },
];

for (const failure of failures) {
  for (const recoverBeforeTimeout of [false, true]) {
    test(`${failure.name}: ${recoverBeforeTimeout ? "republish without rerunning action" : "consumer times out and preserves evidence"}`, async () => {
      // Keep fault evidence under TMPDIR for inspection after the run.
      const root = await mkdtemp(join(tmpdir(), "cueline-publication-failure-"));
      const id = "req-100-1";
      const inflightPath = join(root, "inflight", `${id}.json`);
      const responsePath = join(root, "responses", `${id}.json`);
      const partialPath = `${responsePath}.partial`;
      const blocker = failure.blocker === "state" ? `${inflightPath}.partial`
        : failure.blocker === "response" ? partialPath : responsePath;
      const response: FileBridgeResponse = { id, ok: true, result: { id: "tab-created", url: "about:blank" } };
      let time = 100;
      let polls = 0;
      let actions = 0;
      let settled = false;
      let evidence = "";
      const tools = createFileBridgeTools({
        root,
        fs: disk,
        newRequestId: () => id,
        now: () => time,
        requestTimeoutMs: 100,
        claimedTimeoutMs: 10,
        pollIntervalMs: 1,
        sleep: async () => {
          polls += 1;
          assert.ok(polls <= 2, "consumer must not poll indefinitely");
          assert.equal(settled, false, "no result may be delivered before publication");
          if (polls === 1) {
            const claimed = await claimNextHostMailboxRequest(root, () => time);
            assert.equal(claimed?.id, id);
            assert.equal(claimed?.phase, "action_started");
            // The browser action has already returned a result; only publication fails.
            actions += 1;
            if (!failure.late) await mkdir(blocker);
            let stateWrites = 0;
            await assert.rejects(publishHostMailboxResponse(root, response, () => {
              stateWrites += 1;
              // The second timestamp is requested after both the completed state
              // and response partial have reached disk. Obstruct that state write.
              if (failure.late && stateWrites === 2) mkdirSync(blocker);
              return time;
            }), (error: unknown) => {
              assert.ok(["EISDIR", "ENOTDIR", "EEXIST", "ENOTEMPTY"].includes(
                (error as NodeJS.ErrnoException).code ?? "",
              ));
              return true;
            });
            assert.equal((await stat(blocker)).isDirectory(), true);
            evidence = await readFile(inflightPath, "utf8");
            const recorded = JSON.parse(evidence);
            assert.equal(recorded.id, id);
            assert.equal(recorded.method, "newTab");
            assert.equal(recorded.phase, failure.phase);
            assert.deepEqual(await readdir(join(root, "requests")), []);
            if (failure.hasPartial) {
              assert.deepEqual(JSON.parse(await readFile(partialPath, "utf8")), response);
            }
            // Move, rather than delete, the injected obstruction. In particular,
            // the final-path directory is not a response and must not be parsed.
            await rename(blocker, join(root, "fault-directory"));
            assert.equal(await disk.read(responsePath), undefined);
            if (!failure.hasPartial) assert.equal(await disk.read(partialPath), undefined);
            assert.equal(await claimNextHostMailboxRequest(root, () => time), undefined);
            assert.equal(await readFile(inflightPath, "utf8"), evidence);
            await writeFile(join(root, "failure-state.json"), evidence, "utf8");
          } else {
            // A complete consumer poll has now seen the failure phase and no
            // final response. It neither accepted a partial nor cleared evidence.
            assert.equal(await readFile(inflightPath, "utf8"), evidence);
            assert.equal(await claimNextHostMailboxRequest(root, () => time), undefined);
            if (recoverBeforeTimeout) {
              await publishHostMailboxResponse(root, response, () => time);
            } else {
              time += 10;
            }
          }
        },
      });
      const result = tools.newTab("about:blank");
      void result.then(() => { settled = true; }, () => { settled = true; });
      if (recoverBeforeTimeout) {
        assert.deepEqual(await result, response.result);
        assert.equal(await disk.read(responsePath), undefined);
        assert.equal(await disk.read(inflightPath), undefined);
      } else {
        await assert.rejects(result, (error: unknown) => {
          assert.ok(error instanceof CueLineError);
          assert.equal(error.code, "HOST_BRIDGE_ACTION_OUTCOME_UNKNOWN");
          assert.deepEqual(error.details, {
            id, method: "newTab", claimed: true, phase: failure.phase, timeoutMs: 10,
          });
          return true;
        });
        assert.equal(await readFile(inflightPath, "utf8"), evidence);
        assert.equal(await disk.read(responsePath), undefined);
        assert.equal(await claimNextHostMailboxRequest(root, () => time), undefined);
        // Recovery remains possible after the consumer has stopped waiting.
        await publishHostMailboxResponse(root, response, () => time);
        assert.deepEqual(JSON.parse(await readFile(responsePath, "utf8")), response);
        assert.equal(JSON.parse(await readFile(inflightPath, "utf8")).phase, "response_published");
      }
      assert.equal(await disk.read(partialPath), undefined);
      assert.equal(polls, 2);
      assert.equal(actions, 1);
    });
  }
}
