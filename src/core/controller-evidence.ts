export const MAX_CONTROLLER_EVIDENCE_CHARS = 12_000;
export const DEFAULT_MAX_JOB_EVIDENCE_CHARS = 12_000;

export interface CappedControllerEvidence {
  value: string;
  totalChars: number;
  truncatedChars: number;
}

export function capControllerEvidence(
  value: string,
  maximum: number,
): CappedControllerEvidence {
  if (value.length <= maximum) {
    return { value, totalChars: value.length, truncatedChars: 0 };
  }
  const truncatedChars = value.length - maximum;
  return {
    value: `${value.slice(0, maximum)}\n...[job evidence capped: ${truncatedChars} chars omitted; total_chars=${value.length}; cap=${maximum}]`,
    totalChars: value.length,
    truncatedChars,
  };
}

export function controllerEvidenceCapacityNotice(
  totalUnservedChars: number,
  round: number,
  maxRounds: number,
  perRoundBudget = MAX_CONTROLLER_EVIDENCE_CHARS,
): string | undefined {
  const remainingRounds = Math.max(0, maxRounds - round + 1);
  const remainingCapacity = remainingRounds * perRoundBudget;
  if (totalUnservedChars <= remainingCapacity) return undefined;
  return `[controller evidence capacity warning: evidence total ${totalUnservedChars} chars exceeds remaining round capacity ${remainingCapacity} chars; decide from summaries or dispatch a summarization task instead of paging]`;
}
