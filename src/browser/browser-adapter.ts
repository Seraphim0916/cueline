export interface BrowserTurnInput {
  runId: string;
  round: number;
  requestId: string;
  prompt: string;
  repairAttempt?: number;
  manualSendConfirmed?: boolean;
  attachmentPromptExpected?: boolean;
  baselineAssistantMessageCount?: number;
  signal?: AbortSignal;
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

export type ControllerSubmissionState = "submitting" | "possibly_sent" | "submitted";
export type ComposerPromptState = "inline_ready" | "attachment_ready";

export interface BrowserTurnCheckpoint {
  submissionState: ControllerSubmissionState;
  composerPromptState: ComposerPromptState;
  conversationUrl?: string;
  selectedModelLabel: string;
  baselineAssistantMessageCount: number;
}

export interface BrowserTurnHooks {
  onCheckpoint?: (checkpoint: BrowserTurnCheckpoint) => Promise<void>;
}

export interface BrowserAdapter {
  /** Submit durably and return after the submitted checkpoint, without waiting for Pro. */
  submitTurn?(input: BrowserTurnInput, hooks?: BrowserTurnHooks): Promise<void>;
  /** Observe the exact submitted turn once; undefined means Pro is not finished yet. */
  observeTurn?(input: BrowserTurnInput): Promise<ControllerTurn | undefined>;
  sendTurn(input: BrowserTurnInput, hooks?: BrowserTurnHooks): Promise<ControllerTurn>;
  recoverTurn?(input: BrowserTurnInput): Promise<ControllerTurn>;
}
