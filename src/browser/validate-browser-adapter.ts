import type { BrowserAdapter } from "./browser-adapter.js";
import { CueLineError } from "../core/errors.js";

type BrowserAdapterCandidate = Partial<Record<keyof BrowserAdapter, unknown>>;

export function assertBrowserAdapterContract(
  candidate: unknown,
): asserts candidate is BrowserAdapter {
  const value =
    typeof candidate === "object" && candidate !== null
      ? (candidate as BrowserAdapterCandidate)
      : {};
  const missingMethods: string[] = [];

  if (typeof value.sendTurn !== "function") missingMethods.push("sendTurn");

  const splitSubmissionProvided =
    value.submitTurn !== undefined || value.observeTurn !== undefined;
  if (splitSubmissionProvided) {
    if (typeof value.submitTurn !== "function") missingMethods.push("submitTurn");
    if (typeof value.observeTurn !== "function") missingMethods.push("observeTurn");
  }

  if (missingMethods.length === 0) return;
  throw new CueLineError(
    "BROWSER_ADAPTER_INVALID",
    `Browser adapter is missing required methods: ${missingMethods.join(", ")}.`,
    { details: { missingMethods } },
  );
}
