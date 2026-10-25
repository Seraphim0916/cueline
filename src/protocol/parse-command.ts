import { CueLineError } from "../core/errors.js";
import { MAX_CONTROLLER_ENVELOPE_CHARS } from "./limits.js";
import type { ControllerCommand, ExpectedControllerIdentity } from "./types.js";
import { validateControllerCommand } from "./validate-command.js";

const CONTROL_OPEN = "<CueLineControl>";
const CONTROL_CLOSE = "</CueLineControl>";

/** Tags inside JSON strings are content, including after escaped quotes. */
function lastEnvelopeBody(text: string): string | undefined {
  let body: string | undefined;
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf(CONTROL_OPEN, cursor);
    if (open === -1) break;
    const start = open + CONTROL_OPEN.length;
    let inString = false;
    let escaped = false;
    let fallbackClose = -1;
    cursor = text.length;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (text.startsWith(CONTROL_CLOSE, i)) fallbackClose = i;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
      } else if (text.startsWith(CONTROL_CLOSE, i)) {
        body = text.slice(start, i);
        cursor = i + CONTROL_CLOSE.length;
        fallbackClose = -1;
        break;
      }
    }
    // A tag hidden by an unterminated quote still closes a malformed envelope.
    // Let JSON.parse reject it instead of replaying the previous command.
    if (fallbackClose !== -1) body = text.slice(start, fallbackClose);
  }
  return body;
}

export function parseControllerCommand(
  text: string,
  expected: ExpectedControllerIdentity,
): ControllerCommand {
  const body = lastEnvelopeBody(text);
  if (body === undefined) {
    throw new CueLineError(
      "CONTROL_ENVELOPE_MISSING",
      "No complete <CueLineControl> envelope was found.",
    );
  }
  if (body.length > MAX_CONTROLLER_ENVELOPE_CHARS) {
    throw new CueLineError(
      "CONTROL_ENVELOPE_TOO_LARGE",
      `Control envelope exceeds the ${MAX_CONTROLLER_ENVELOPE_CHARS}-character protocol limit.`,
      { details: { maximum_chars: MAX_CONTROLLER_ENVELOPE_CHARS } },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch (error) {
    throw new CueLineError("CONTROL_JSON_INVALID", "Control envelope contains invalid JSON.", {
      cause: error,
    });
  }
  return validateControllerCommand(parsed, expected);
}
