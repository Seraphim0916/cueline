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

export interface BrowserConversationArchiveInput {
  conversationUrl: string;
  signal?: AbortSignal;
}

export interface BrowserConversationArchiveEvidence {
  conversationUrl: string;
  proof: "conversation_url_changed";
  postActionUrl: string;
}

export interface BrowserConversationArchiveHooks {
  /** Durable write-ahead checkpoint that must finish before the one Archive click. */
  onBeforeArchiveClick?: () => Promise<void>;
}

export interface BrowserAdapter {
  /**
   * Declares that `controller_turn_requested` is durably recorded before any
   * submission side effect and every later submission phase is checkpointed.
   */
  readonly submissionCheckpointContract?: "write_ahead_v1";
  /** Submit durably and return after the submitted checkpoint, without waiting for Pro. */
  submitTurn?(input: BrowserTurnInput, hooks?: BrowserTurnHooks): Promise<void>;
  /** Observe the exact submitted turn once; undefined means Pro is not finished yet. */
  observeTurn?(input: BrowserTurnInput): Promise<ControllerTurn | undefined>;
  sendTurn(input: BrowserTurnInput, hooks?: BrowserTurnHooks): Promise<ControllerTurn>;
  recoverTurn?(input: BrowserTurnInput): Promise<ControllerTurn>;
  /** Archive one exact completed controller conversation. Implementations must never retry the archive click. */
  archiveConversation?(
    input: BrowserConversationArchiveInput,
    hooks?: BrowserConversationArchiveHooks,
  ): Promise<BrowserConversationArchiveEvidence>;
}
