import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../core/ids.js";

export interface RunEvent {
  sequence: number;
  timestamp: string;
  type: string;
  payload: unknown;
}

function validateEvent(value: unknown, expectedSequence: number): RunEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`EVENT_LOG_INVALID: event ${expectedSequence} is not an object`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.sequence !== expectedSequence ||
    typeof record.timestamp !== "string" ||
    typeof record.type !== "string" ||
    record.type === ""
  ) {
    throw new Error(`EVENT_LOG_INVALID: malformed event ${expectedSequence}`);
  }
  return {
    sequence: expectedSequence,
    timestamp: record.timestamp,
    type: record.type,
    payload: record.payload,
  };
}

export async function appendEvent(file: string, event: RunEvent): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, "a", 0o600);
  try {
    await handle.writeFile(`${canonicalJson(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readEvents(file: string): Promise<RunEvent[]> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const lines = contents.split("\n").filter((line) => line.trim() !== "");
  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`EVENT_LOG_INVALID: invalid JSON at line ${index + 1}`, { cause: error });
    }
    return validateEvent(parsed, index + 1);
  });
}
