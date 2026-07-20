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
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n(?:[ \t]*\n)+/g, "\n")
    .trim();
}

export function hasExactControllerEnvelopeIdentity(
  text: string,
  expected: ExpectedControllerIdentity,
): boolean {
  return exactControllerEnvelopeText(text, expected) !== null;
}

export function exactControllerEnvelopeText(
  text: string,
  expected: ExpectedControllerIdentity,
): string | null {
  let body: string | undefined;
  for (const match of text.matchAll(CONTROL_ENVELOPE)) body = match[1];
  if (body === undefined) return null;

  const rawBody = body.trim();
  const candidates = [rawBody];
  try {
    const decoded = JSON.parse(
      `"${rawBody.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`,
    ) as unknown;
    if (typeof decoded === "string" && decoded.trim() !== rawBody) {
      candidates.push(decoded.trim());
    }
  } catch {
    // A normal DOM response is already raw JSON; only accessibility snapshots
    // that quote the scalar need the one-level decode above.
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (
        parsed.protocol === "cueline/0.1" &&
        parsed.run_id === expected.runId &&
        parsed.round === expected.round &&
        parsed.request_id === expected.requestId
      ) {
        return `<CueLineControl>${candidate}</CueLineControl>`;
      }
    } catch {
      // Try the accessibility-decoded candidate, if one exists.
    }
  }
  return null;
}

function hasChatGptAssistantArticleHeader(
  lines: readonly string[],
  start: number,
  end: number,
): boolean {
  const articleHeader = (lines[start] ?? "").trimStart();
  if (/^-\s+article(?:\s+|:\s*)(?:["']\s*)?ChatGPT\b/i.test(articleHeader)) {
    return true;
  }
  return lines
    .slice(start + 1, Math.min(end, start + 4))
    .some((line) =>
      /^\s*-\s+heading(?:\s+|:\s*)(?:["']\s*)?ChatGPT\b/i.test(line),
    );
}

export function exactAccessibilityControllerEnvelopeText(
  snapshot: string,
  expected: ExpectedControllerIdentity,
): string | null {
  const lines = snapshot.split(/\r?\n/);
  let exactEnvelope: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const article = /^(\s*)- article(?:\s|:|$)/i.exec(lines[index] ?? "");
    if (article === null) continue;
    const articleIndent = article[1]?.length ?? 0;
    let end = index + 1;
    while (end < lines.length) {
      const line = lines[end] ?? "";
      const trimmed = line.trimStart();
      const indent = line.length - trimmed.length;
      if (trimmed !== "" && indent <= articleIndent && trimmed.startsWith("- ")) {
        break;
      }
      end += 1;
    }
    if (hasChatGptAssistantArticleHeader(lines, index, end)) {
      const candidate = exactControllerEnvelopeText(
        lines.slice(index, end).join("\n"),
        expected,
      );
      if (candidate !== null) exactEnvelope = candidate;
    }
    index = end - 1;
  }
  return exactEnvelope;
}
