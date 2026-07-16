import { CueLineError } from "../core/errors.js";
import type {
  CandidateAvailabilityChecker,
  LaneConfig,
  ResolvedRoute,
  RouteAvailability,
  RouteCandidate,
  RoutingConfig,
} from "./types.js";

export function validateRouteReference(
  lane: string,
  config: RoutingConfig,
  requestedCandidateId?: string,
): LaneConfig {
  const laneConfig = Object.hasOwn(config.lanes, lane)
    ? config.lanes[lane]
    : undefined;
  if (laneConfig === undefined) {
    const runnerLanes = Object.entries(config.lanes)
      .filter(([, candidateLane]) =>
        candidateLane.candidates.some((candidate) => candidate.id === lane),
      )
      .map(([name]) => name);
    const correction =
      runnerLanes.length === 0
        ? ""
        : ` '${lane}' is a runner ID; use lane '${runnerLanes[0]}' with runner '${lane}'.`;
    throw new CueLineError(
      "ROUTE_LANE_UNKNOWN",
      `unknown routing lane: ${lane}.${correction}`,
      { details: { lane, ...(runnerLanes.length === 0 ? {} : { runner_lanes: runnerLanes }) } },
    );
  }
  if (!laneConfig.enabled) {
    throw new CueLineError("ROUTE_LANE_DISABLED", `routing lane is disabled: ${lane}`, {
      details: { lane },
    });
  }
  if (requestedCandidateId !== undefined) {
    const candidate = laneConfig.candidates.find(
      (entry) => entry.id === requestedCandidateId,
    );
    if (candidate === undefined) {
      throw new CueLineError(
        "ROUTE_RUNNER_UNKNOWN",
        `runner '${requestedCandidateId}' is not configured for lane: ${lane}`,
        { details: { lane, runner: requestedCandidateId } },
      );
    }
    if (candidate.enabled === false) {
      throw new CueLineError(
        "ROUTE_RUNNER_DISABLED",
        `runner '${requestedCandidateId}' is disabled for lane: ${lane}`,
        { details: { lane, runner: requestedCandidateId } },
      );
    }
  }
  return laneConfig;
}

function isAvailabilityChecker(value: RouteAvailability): value is CandidateAvailabilityChecker {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "isAvailable") &&
    typeof value.isAvailable === "function"
  );
}

export function routeCandidateIsAvailable(
  availability: RouteAvailability,
  candidate: RouteCandidate,
  lane: string,
): boolean {
  if (typeof availability === "function") {
    return availability(candidate, lane);
  }
  if (isAvailabilityChecker(availability)) {
    return availability.isAvailable(candidate, lane);
  }
  return Object.hasOwn(availability, candidate.id) && availability[candidate.id] === true;
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
  const laneConfig = validateRouteReference(lane, config, requestedCandidateId);

  if (requestedCandidateId !== undefined) {
    const candidateIndex = laneConfig.candidates.findIndex(
      (candidate) => candidate.id === requestedCandidateId,
    );
    if (candidateIndex < 0) throw new Error("ROUTE_REFERENCE_VALIDATION_INCONSISTENT");
    const candidate = laneConfig.candidates[candidateIndex];
    if (candidate === undefined || candidate.enabled === false) {
      throw new Error("ROUTE_REFERENCE_VALIDATION_INCONSISTENT");
    }
    if (!routeCandidateIsAvailable(availability, candidate, lane)) {
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
    if (routeCandidateIsAvailable(availability, candidate, lane)) {
      return { lane, candidate, candidateIndex };
    }
  }

  throw new CueLineError("ROUTE_NO_CANDIDATE", `no available candidate for routing lane: ${lane}`, {
    details: { lane },
  });
}
