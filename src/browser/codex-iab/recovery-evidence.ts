import type { ExpectedControllerIdentity } from "../../protocol/types.js";
export { normalizedConversationUrl } from "../../core/conversation-url.js";

const CONTROL_ENVELOPE = /<CueLineControl>([\s\S]*?)<\/CueLineControl>/g;

export function isProLabel(label: string | null): label is string {
  return /^Pro(?:\s+(?:Standard|Extended))?$/i.test(label ?? "");
}

export function isProModelSlug(slug: string | null): slug is string {
  return /^gpt-\d+(?:[.-]\d+)*-pro$/i.test(slug ?? "");
}

export function normalizedMessageText(value: string | null): string {
  return (value ?? "").replace(/\r\n/g, "\n").trim();
}

export function hasExactControllerEnvelopeIdentity(
  text: string,
  expected: ExpectedControllerIdentity,
): boolean {
  let body: string | undefined;
  for (const match of text.matchAll(CONTROL_ENVELOPE)) body = match[1];
  if (body === undefined) return false;
  try {
    const parsed = JSON.parse(body.trim()) as Record<string, unknown>;
    return (
      parsed.protocol === "cueline/0.1" &&
      parsed.run_id === expected.runId &&
      parsed.round === expected.round &&
      parsed.request_id === expected.requestId
    );
  } catch {
    return false;
  }
}
