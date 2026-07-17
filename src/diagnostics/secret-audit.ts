import type { CueLineRuntimeOptions } from "../api-contracts.js";
import { CueLineError } from "../core/errors.js";
import { runtimeEnvironment } from "../core/runtime.js";
import { defaultCueLineHome } from "../state/paths.js";
import { readAuthoritativeRunEvents } from "../state/store.js";

export const SECRET_AUDIT_PROTOCOL = "cueline-secret-audit/0.1";

export type SecretFindingKind =
  | "aws_access_key_id"
  | "github_token"
  | "slack_token"
  | "anthropic_api_key"
  | "openai_api_key"
  | "google_api_key"
  | "jwt"
  | "private_key_block"
  | "bearer_token"
  | "credential_assignment";

interface SecretDetector {
  kind: SecretFindingKind;
  pattern: RegExp;
}

// Order matters: the first matching detector claims the span, so the more
// specific prefixes (sk-ant-) must run before their generic parents (sk-).
const DETECTORS: readonly SecretDetector[] = [
  { kind: "private_key_block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: "aws_access_key_id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    kind: "github_token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
  },
  { kind: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "anthropic_api_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "openai_api_key", pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
  { kind: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  },
  { kind: "bearer_token", pattern: /\bBearer +[A-Za-z0-9._~+/=-]{20,}\b/g },
  {
    kind: "credential_assignment",
    pattern:
      /\b(?:api[_-]?key|secret|token|password|passwd|credential)s?\b['"]? *[:=] *['"]?[A-Za-z0-9_/+.=-]{12,}/gi,
  },
];

export interface CueLineSecretFinding {
  kind: SecretFindingKind;
  sequence: number;
  eventType: string;
  path: string;
  matchLength: number;
  maskedPreview: string;
}

export interface CueLineSecretAuditReport {
  protocol: typeof SECRET_AUDIT_PROTOCOL;
  runId: string;
  scannedEvents: number;
  scannedFields: number;
  findings: CueLineSecretFinding[];
  clean: boolean;
}

function maskedPreview(match: string): string {
  const visible = match.slice(0, 4);
  return `${visible}…(${match.length} chars)`;
}

function scanText(
  text: string,
  sequence: number,
  eventType: string,
  fieldPath: string,
  findings: CueLineSecretFinding[],
): void {
  const claimed: Array<[number, number]> = [];
  for (const detector of DETECTORS) {
    detector.pattern.lastIndex = 0;
    for (const match of text.matchAll(detector.pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (claimed.some(([from, to]) => start < to && end > from)) continue;
      claimed.push([start, end]);
      findings.push({
        kind: detector.kind,
        sequence,
        eventType,
        path: fieldPath,
        matchLength: match[0].length,
        maskedPreview: maskedPreview(match[0]),
      });
    }
  }
}

/**
 * Path segments are part of the report, so a secret-shaped object key must
 * never appear verbatim: mask it in the path and report the key itself.
 */
function safePathSegment(key: string): string {
  for (const detector of DETECTORS) {
    detector.pattern.lastIndex = 0;
    if (detector.pattern.test(key)) return maskedPreview(key);
  }
  return key;
}

function walk(
  value: unknown,
  sequence: number,
  eventType: string,
  fieldPath: string,
  findings: CueLineSecretFinding[],
  counter: { fields: number },
): void {
  if (typeof value === "string") {
    counter.fields += 1;
    scanText(value, sequence, eventType, fieldPath, findings);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walk(item, sequence, eventType, `${fieldPath}[${index}]`, findings, counter);
    });
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      const segment = safePathSegment(key);
      const childPath = `${fieldPath}.${segment}`;
      scanText(key, sequence, eventType, childPath, findings);
      walk(item, sequence, eventType, childPath, findings, counter);
    }
  }
}

/**
 * Read-only sweep of a run's durable events for secret-shaped strings.
 * The report never contains the matched bytes; each finding carries only
 * the kind, location, length, and a four-character masked preview.
 */
export async function auditCueLineRunSecrets(
  runId: string,
  options: Pick<CueLineRuntimeOptions, "home" | "environment"> = {},
): Promise<CueLineSecretAuditReport> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  const events = await readAuthoritativeRunEvents(home, runId);
  if (events.length === 0) {
    throw new CueLineError(
      "RUN_NOT_FOUND",
      `Run '${runId}' has no durable events; refusing to report a missing run as clean.`,
    );
  }
  const findings: CueLineSecretFinding[] = [];
  const counter = { fields: 0 };
  for (const event of events) {
    walk(event.payload, event.sequence, event.type, "payload", findings, counter);
  }
  findings.sort(
    (left, right) => left.sequence - right.sequence || left.path.localeCompare(right.path),
  );
  return {
    protocol: SECRET_AUDIT_PROTOCOL,
    runId,
    scannedEvents: events.length,
    scannedFields: counter.fields,
    findings,
    clean: findings.length === 0,
  };
}
