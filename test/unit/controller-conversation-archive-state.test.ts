import assert from "node:assert/strict";
import test from "node:test";

import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import type { RunEvent } from "../../src/state/event-log.js";

function event(type: string, payload: unknown, sequence: number): RunEvent {
  return {
    sequence,
    timestamp: `2026-07-16T00:00:0${sequence}.000Z`,
    type,
    payload,
  };
}

test("archive evidence must match the exact completed conversation", () => {
  const conversationUrl = "https://chatgpt.com/c/archive-state-evidence";
  let state = initialRunState(
    "run_archive_state_evidence",
    "archive after completion",
    "caller",
    12,
    false,
    true,
  );
  state = reduceRunState(
    state,
    event("controller_conversation_bound", { conversation_url: conversationUrl }, 1),
  );
  state = reduceRunState(
    state,
    event("run_completed", { final_delivery_text: "COMPLETE" }, 2),
  );
  state = reduceRunState(
    state,
    event(
      "controller_conversation_archive_started",
      { conversation_url: conversationUrl },
      3,
    ),
  );

  const wrongConversation = reduceRunState(
    state,
    event(
      "controller_conversation_archived",
      {
        conversation_url: "https://chatgpt.com/c/other-conversation",
        proof: "conversation_url_changed",
        post_action_url: "https://chatgpt.com/",
      },
      4,
    ),
  );
  assert.equal(wrongConversation.controllerConversationArchive.status, "started");

  const unchangedUrl = reduceRunState(
    state,
    event(
      "controller_conversation_archived",
      {
        conversation_url: conversationUrl,
        proof: "conversation_url_changed",
        post_action_url: conversationUrl,
      },
      4,
    ),
  );
  assert.equal(unchangedUrl.controllerConversationArchive.status, "started");

  const archived = reduceRunState(
    state,
    event(
      "controller_conversation_archived",
      {
        conversation_url: conversationUrl,
        proof: "conversation_url_changed",
        post_action_url: "https://chatgpt.com/",
      },
      4,
    ),
  );
  assert.equal(archived.controllerConversationArchive.status, "archived");
});
