import { CueLineError } from "../core/errors.js";
import { MAX_CONTROLLER_ENVELOPE_CHARS } from "./limits.js";
import type { ControllerCommand, ExpectedControllerIdentity } from "./types.js";
import { validateControllerCommand } from "./validate-command.js";

const CONTROL_ENVELOPE = /<CueLineControl>([\s\S]*?)<\/CueLineControl>/g;

export function parseControllerCommand(
  text: string,
  expected: ExpectedControllerIdentity,
): ControllerCommand {
  let body: string | undefined;
  for (const match of text.matchAll(CONTROL_ENVELOPE)) {
    body = match[1];
  }
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
