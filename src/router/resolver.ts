import { CueLineError } from "../core/errors.js";
import type {
  CandidateAvailabilityChecker,
  ResolvedRoute,
  RouteAvailability,
  RouteCandidate,
  RoutingConfig,
} from "./types.js";

function isAvailabilityChecker(value: RouteAvailability): value is CandidateAvailabilityChecker {
  return typeof value === "object" && value !== null && "isAvailable" in value;
}

function isAvailable(availability: RouteAvailability, candidate: RouteCandidate, lane: string): boolean {
  if (typeof availability === "function") {
    return availability(candidate, lane);
  }
  if (isAvailabilityChecker(availability)) {
    return availability.isAvailable(candidate, lane);
  }
  return availability[candidate.id] === true;
}

/**
 * Chooses a candidate before any runner is invoked. This function never spawns
 * a process and therefore cannot perform post-spawn fallback.
 */
export function resolveRoute(
  lane: string,
  config: RoutingConfig,
  availability: RouteAvailability,
  requestedCandidateId?: string,
): ResolvedRoute {
  const laneConfig = config.lanes[lane];
  if (laneConfig === undefined) {
    throw new CueLineError("ROUTE_LANE_UNKNOWN", `unknown routing lane: ${lane}`, { details: { lane } });
  }
  if (!laneConfig.enabled) {
    throw new CueLineError("ROUTE_LANE_DISABLED", `routing lane is disabled: ${lane}`, {
      details: { lane },
    });
  }

  if (requestedCandidateId !== undefined) {
    const candidateIndex = laneConfig.candidates.findIndex(
      (candidate) => candidate.id === requestedCandidateId,
    );
    if (candidateIndex < 0) {
      throw new CueLineError(
        "ROUTE_RUNNER_UNKNOWN",
        `runner '${requestedCandidateId}' is not configured for lane: ${lane}`,
        { details: { lane, runner: requestedCandidateId } },
      );
    }
    const candidate = laneConfig.candidates[candidateIndex];
    if (candidate === undefined || candidate.enabled === false) {
      throw new CueLineError(
        "ROUTE_RUNNER_DISABLED",
        `runner '${requestedCandidateId}' is disabled for lane: ${lane}`,
        { details: { lane, runner: requestedCandidateId } },
      );
    }
    if (!isAvailable(availability, candidate, lane)) {
      throw new CueLineError(
        "ROUTE_RUNNER_UNAVAILABLE",
        `runner '${requestedCandidateId}' is unavailable for lane: ${lane}`,
        { details: { lane, runner: requestedCandidateId } },
      );
    }
    return { lane, candidate, candidateIndex };
  }

  for (let candidateIndex = 0; candidateIndex < laneConfig.candidates.length; candidateIndex += 1) {
    const candidate = laneConfig.candidates[candidateIndex];
    if (candidate === undefined || candidate.enabled === false) {
      continue;
    }
    if (isAvailable(availability, candidate, lane)) {
      return { lane, candidate, candidateIndex };
    }
  }

  throw new CueLineError("ROUTE_NO_CANDIDATE", `no available candidate for routing lane: ${lane}`, {
    details: { lane },
  });
}
