import type { RuntimeOwnerRetirementEvidence } from "./runtime-retirement.js";

const RETIREMENT_EVIDENCE_FIELDS = new Set([
  "owner_id",
  "events_after_sequence",
  "retired_at",
]);

export function isNonEmptyRuntimeIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value
  );
}

export function isCanonicalRuntimeTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

export function isSafeRuntimeGeneration(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  );
}

export function isRuntimeOwnerRetirementEvidence(
  value: unknown,
): value is RuntimeOwnerRetirementEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((field) => RETIREMENT_EVIDENCE_FIELDS.has(field)) &&
    isNonEmptyRuntimeIdentity(record.owner_id) &&
    Number.isSafeInteger(record.events_after_sequence) &&
    (record.events_after_sequence as number) >= 0 &&
    isCanonicalRuntimeTimestamp(record.retired_at)
  );
}

export function parseRetiredRuntimeOwners(
  value: unknown,
): RuntimeOwnerRetirementEvidence[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("RUNTIME_LEASE_INVALID");
  return value.map((candidate) => {
    if (!isRuntimeOwnerRetirementEvidence(candidate)) {
      throw new Error("RUNTIME_LEASE_INVALID");
    }
    return { ...candidate };
  });
}
