#!/usr/bin/env node

import { publishHostMailboxResponse, waitForHostMailboxRequest } from "../src/browser/claude-desktop/host-mailbox.js";
import type { FileBridgeResponse } from "../src/browser/claude-desktop/file-bridge.js";

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) raw += String(chunk);
  return raw;
}

const [command, root, id] = process.argv.slice(2);
if (root === undefined || root.trim() === "") {
  throw new Error("usage: claude-desktop-mailbox.ts <claim|respond> <bridge-root> [request-id]");
}

if (command === "claim") {
  process.stdout.write(`${JSON.stringify(await waitForHostMailboxRequest(root))}\n`);
} else if (command === "respond") {
  const raw = await readStdin();
  const response = JSON.parse(raw) as FileBridgeResponse;
  if (id !== undefined && response.id !== id) {
    throw new Error(`response id ${response.id} does not match expected ${id}`);
  }
  await publishHostMailboxResponse(root, response);
  process.stdout.write(`${JSON.stringify({ id: response.id, published: true })}\n`);
} else {
  throw new Error("usage: claude-desktop-mailbox.ts <claim|respond> <bridge-root> [request-id]");
}
