import { routeCandidateIsAvailable } from "./resolver.js";
import type { RouteAvailability, RoutingConfig } from "./types.js";

export type RoutingCandidateReasonCode =
  | "AVAILABLE_FALLBACK"
  | "LANE_DISABLED"
  | "RUNNER_DISABLED"
  | "RUNNER_UNAVAILABLE"
  | "SELECTED_FIRST_AVAILABLE";

export interface RoutingCandidateExplanation {
  id: string;
  index: number;
  enabled: boolean;
  available: boolean | null;
  selected: boolean;
  reasonCode: RoutingCandidateReasonCode;
}

export interface RoutingLaneExplanation {
  name: string;
  enabled: boolean;
  status: "available" | "disabled" | "unavailable";
  selectedRunnerId: string | null;
  candidates: RoutingCandidateExplanation[];
  errorCode?: "ROUTE_NO_CANDIDATE";
}

export interface RoutingExplanation {
  requestedLane: string | null;
  availableLanes: number;
  lanes: RoutingLaneExplanation[];
  findings: Array<{ code: string; message: string }>;
}

export function explainRoutingConfig(
  config: RoutingConfig,
  availability: RouteAvailability,
  requestedLane?: string,
): RoutingExplanation {
  const requestedLaneName = requestedLane ?? null;
  if (requestedLane !== undefined && !Object.hasOwn(config.lanes, requestedLane)) {
    return {
      requestedLane: requestedLaneName,
      availableLanes: 0,
      lanes: [],
      findings: [
        {
          code: "ROUTE_LANE_UNKNOWN",
          message: "Requested lane is not configured.",
        },
      ],
    };
  }

  const entries = requestedLane === undefined
    ? Object.entries(config.lanes)
    : [[requestedLane, config.lanes[requestedLane]] as const];
  const lanes: RoutingLaneExplanation[] = [];

  for (const [name, lane] of entries) {
    if (lane === undefined) continue;
    if (!lane.enabled) {
      lanes.push({
        name,
        enabled: false,
        status: "disabled",
        selectedRunnerId: null,
        candidates: lane.candidates.map((candidate, index) => ({
          id: candidate.id,
          index,
          enabled: candidate.enabled !== false,
          available: null,
          selected: false,
          reasonCode: "LANE_DISABLED",
        })),
      });
      continue;
    }

    let selectedRunnerId: string | null = null;
    const candidates = lane.candidates.map((candidate, index): RoutingCandidateExplanation => {
      if (candidate.enabled === false) {
        return {
          id: candidate.id,
          index,
          enabled: false,
          available: null,
          selected: false,
          reasonCode: "RUNNER_DISABLED",
        };
      }
      const available = routeCandidateIsAvailable(availability, candidate, name);
      const selected = available && selectedRunnerId === null;
      if (selected) selectedRunnerId = candidate.id;
      return {
        id: candidate.id,
        index,
        enabled: true,
        available,
        selected,
        reasonCode: !available
          ? "RUNNER_UNAVAILABLE"
          : selected
            ? "SELECTED_FIRST_AVAILABLE"
            : "AVAILABLE_FALLBACK",
      };
    });
    lanes.push({
      name,
      enabled: true,
      status: selectedRunnerId === null ? "unavailable" : "available",
      selectedRunnerId,
      candidates,
      ...(selectedRunnerId === null ? { errorCode: "ROUTE_NO_CANDIDATE" as const } : {}),
    });
  }

  return {
    requestedLane: requestedLaneName,
    availableLanes: lanes.filter((lane) => lane.status === "available").length,
    lanes,
    findings: [],
  };
}
