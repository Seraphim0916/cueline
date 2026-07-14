import { CueLineError } from "../core/errors.js";
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
