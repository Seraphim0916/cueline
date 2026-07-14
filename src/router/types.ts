export interface RouteCandidate {
  id: string;
  argv: readonly string[];
  task_input?: "argv" | "stdin";
  enabled?: boolean;
}

export interface LaneConfig {
  enabled: boolean;
  candidates: readonly RouteCandidate[];
}

export interface RoutingConfig {
  version: 1;
  lanes: Readonly<Record<string, LaneConfig>>;
}

export type CandidateAvailability = (candidate: RouteCandidate, lane: string) => boolean;

export interface CandidateAvailabilityChecker {
  isAvailable(candidate: RouteCandidate, lane: string): boolean;
}

export type RouteAvailability =
  | CandidateAvailability
  | CandidateAvailabilityChecker
  | Readonly<Record<string, boolean | undefined>>;

export interface ResolvedRoute {
  lane: string;
  candidate: RouteCandidate;
  candidateIndex: number;
}
