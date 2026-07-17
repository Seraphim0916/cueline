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

export function capReplayedControllerEvidence(
  value: string,
  declaredTotalChars: number | undefined,
  maximum: number,
): CappedControllerEvidence {
  // Only event-backed evidence uses this path. Preserve a marker only when it
  // exactly matches CueLine's durable format, declared true total, and run cap.
  const marker = /\n\.\.\.\[job evidence capped: (\d+) chars omitted; total_chars=(\d+); cap=(\d+)\]$/.exec(
    value,
  );
  if (marker !== null) {
    const omittedChars = Number(marker[1]);
    const totalChars = Number(marker[2]);
    const markerCap = Number(marker[3]);
    if (
      marker.index === maximum &&
      markerCap === maximum &&
      Number.isSafeInteger(declaredTotalChars) &&
      declaredTotalChars === totalChars &&
      Number.isSafeInteger(omittedChars) &&
      omittedChars === totalChars - maximum &&
      omittedChars > 0
    ) {
      return { value, totalChars, truncatedChars: omittedChars };
    }
  }
  return capControllerEvidence(value, maximum);
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
