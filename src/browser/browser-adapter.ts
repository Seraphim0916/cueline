export interface BrowserTurnInput {
  runId: string;
  round: number;
  requestId: string;
  prompt: string;
  repairAttempt?: number;
}

export interface ControllerTurn {
  text: string;
  conversationUrl?: string;
  title?: string;
  model?: ControllerModelEvidence;
}

export interface ControllerModelEvidence {
  provider: "chatgpt";
  selectedLabel: string;
  responseModelSlug: string;
  source: "composer_and_response";
}

export type ControllerSubmissionState = "possibly_sent" | "submitted";

export interface BrowserTurnCheckpoint {
  submissionState: ControllerSubmissionState;
  conversationUrl?: string;
  selectedModelLabel: string;
  baselineAssistantMessageCount: number;
}

export interface BrowserTurnHooks {
  onCheckpoint?: (checkpoint: BrowserTurnCheckpoint) => Promise<void>;
}

export interface BrowserAdapter {
  sendTurn(input: BrowserTurnInput, hooks?: BrowserTurnHooks): Promise<ControllerTurn>;
  recoverTurn?(input: BrowserTurnInput): Promise<ControllerTurn>;
}
