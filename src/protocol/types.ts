export const CUELINE_PROTOCOL = "cueline/0.1" as const;

export type JobMode = "advise" | "work";
export type ControllerAction = "dispatch" | "wait" | "inspect" | "complete" | "blocked";

export interface ExpectedControllerIdentity {
  runId: string;
  round: number;
  requestId: string;
}

export interface ControllerJobSpec {
  job_key: string;
  lane: string;
  mode: JobMode;
  task: string;
  required?: boolean;
  timeout_ms?: number;
  runner?: string;
  workdir?: string;
  background?: boolean;
}

interface ControllerCommandBase {
  protocol: typeof CUELINE_PROTOCOL;
  run_id: string;
  round: number;
  request_id: string;
  action: ControllerAction;
}

export interface DispatchCommand extends ControllerCommandBase {
  action: "dispatch";
  jobs: ControllerJobSpec[];
}

export interface WaitCommand extends ControllerCommandBase {
  action: "wait";
  job_ids?: string[];
  wait_ms?: number;
}

export interface InspectCommand extends ControllerCommandBase {
  action: "inspect";
  job_ids?: string[];
  /** Raw-character offset into one explicitly selected job's preferred evidence field. */
  evidence_offset?: number;
  /** SHA-256 identity copied from the selected evidence window. */
  evidence_hash?: string;
}

export interface CompleteCommand extends ControllerCommandBase {
  action: "complete";
  final_delivery_text: string;
}

export interface BlockedCommand extends ControllerCommandBase {
  action: "blocked";
  reason: string;
  final_delivery_text?: string;
}

export type ControllerCommand =
  | DispatchCommand
  | WaitCommand
  | InspectCommand
  | CompleteCommand
  | BlockedCommand;

export interface JobObservation {
  job_id: string;
  job_key: string;
  required: boolean;
  status:
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "timed_out"
    | "cancelled"
    | "ambiguous";
  output?: string;
  /** True source length before the per-job controller evidence cap. */
  output_total_chars?: number;
  error?: string;
  /** True source length before the per-job controller evidence cap. */
  error_total_chars?: number;
  evidence_window?: {
    field: "output" | "error";
    offset: number;
    end: number;
    total_chars: number;
    next_offset: number | null;
    content_hash: string;
  };
}

export interface ControllerObservation {
  protocol: typeof CUELINE_PROTOCOL;
  run_id: string;
  round: number;
  request_id: string;
  user_request: string;
  jobs: JobObservation[];
  notices: string[];
}
