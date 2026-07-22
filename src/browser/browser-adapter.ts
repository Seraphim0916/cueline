export interface BrowserTurnInput {
  runId: string;
  round: number;
  requestId: string;
  prompt: string;
  repairAttempt?: number;
  manualSendConfirmed?: boolean;
  attachmentPromptExpected?: boolean;
  baselineUserMessageCount?: number;
  baselineAssistantMessageCount?: number;
  /** Exact conversation URL expected before any composer mutation or send click. */
  expectedConversationUrl?: string;
  /** Narrow read-only recovery for legacy failures before any submission method call. */
  legacyPreSubmissionRecovery?: boolean;
  /** Read-only proof path for a durable not-sent failure whose old composer payload is gone. */
  emptyComposerNotSentRecovery?: boolean;
  /** Durable one-shot authorization: stage the exact prompt and perform one send action. */
  postFixRetryReauthorized?: boolean;
  /** Replay contains a permanent controller_turn_submitted event for this exact request. */
  durableSubmittedCheckpoint?: boolean;
  notSentRecovery?: {
    abandonedRequestId: string;
    promptHash: string;
    conversationUrl: string;
    baselineUserMessageCount: number;
  };
  signal?: AbortSignal;
}

export type RecoveredResponseSource =
  | "count_degraded_accessibility_exact_envelope"
  | "count_degraded_message_dom_exact_envelope";

export interface PendingObservationDiagnostic {
  code: "CONTROLLER_OBSERVATION_PENDING_STABLE";
  failedCondition: string;
  stableForMs: number;
  thresholdMs: number;
  observedUserMessageCount: number | null;
  baselineUserMessageCount: number;
  requestMessageFound: boolean | null;
  requestMessageFoundBy: "last_text" | "request_id_scan" | "prompt_scan" | null;
  assistantTextFoundBy: "last_message" | "exact_envelope_scan" | "accessibility_exact_envelope" | null;
  composerPromptState: ComposerPromptState | "empty" | null;
  sourcesConsulted: string[];
}

export interface ControllerTurn {
  text: string;
  conversationUrl?: string;
  title?: string;
  model?: ControllerModelEvidence;
  /** Narrow provenance used to preserve a separate dispatch boundary. */
  responseSource?: RecoveredResponseSource;
}

export interface BrowserSubmittedTurnEvidence {
  conversationUrl: string;
  selectedModelLabel: string | null;
  hydrated: boolean;
  baselineUserMessageCount: number;
  observationBaselineUserMessageCount?: number | null;
  observedUserMessageCount: number | null;
  countRegressionDetected?: boolean;
  requestMessageFound: boolean | null;
  requestMessageFoundBy?: "last_text" | "request_id_scan" | "prompt_scan" | null;
  requestMessageScanComplete?: boolean;
  accessibilityRequestIdFound?: boolean | null;
  pendingDiagnostic?: PendingObservationDiagnostic;
  assistantTextFoundBy?: "last_message" | "exact_envelope_scan" | "accessibility_exact_envelope";
  isAnswering: boolean | null;
  /** Redacted composer evidence used to prove that the exact staged turn remains unsent. */
  composerPromptState?: ComposerPromptState | "empty";
  composerAttachmentCount?: number;
  /** Redacted identity evidence; no attachment content or filename is exposed. */
  composerPastedTextAttachmentPresent?: boolean;
  composerSendButtonEnabled?: boolean;
}

export type BrowserSubmittedTurnObservation =
  | {
      status: "response";
      turn: ControllerTurn;
      evidence?: BrowserSubmittedTurnEvidence;
      /** Narrow provenance used to preserve a separate dispatch boundary. */
      responseSource?: RecoveredResponseSource;
    }
| { status: "pending"; evidence?: BrowserSubmittedTurnEvidence }
| { status: "definitely_not_sent"; evidence: BrowserSubmittedTurnEvidence };

export interface BrowserMisdirectedTurnObservationInput {
  runId: string;
  round: number;
  requestId: string;
  prompt: string;
  expectedConversationUrl: string;
  misdirectedConversationUrl: string;
  expectedPriorRound: number;
  expectedPriorRequestId: string;
  signal?: AbortSignal;
}

export interface BrowserMisdirectedTurnEvidence {
  misdirectedConversationUrl: string;
  boundConversationUrl: string;
  selectedModelLabel: string | null;
  misdirected: {
    pageUrl: string;
    isAnswering: boolean;
    assistantMessageCount: number;
    exactEnvelopeFound: boolean;
  };
  bound: {
    pageUrl: string;
    isAnswering: boolean;
    userMessageCount: number | null;
    assistantMessageCount: number;
    requestMessageFound: boolean;
    priorEnvelopeFound: boolean;
  };
}

export type BrowserMisdirectedTurnObservation =
  | { status: "confirmed"; evidence: BrowserMisdirectedTurnEvidence }
  | { status: "pending"; evidence: BrowserMisdirectedTurnEvidence };

export interface ControllerModelEvidence {
  provider: "chatgpt";
  selectedLabel: string;
  responseModelSlug: string;
  source: "composer_and_response";
}

export type ControllerSubmissionState = "submitting" | "possibly_sent" | "submitted";
export type ComposerPromptState = "inline_ready" | "attachment_ready";
export type ClickAttemptState = "attempting" | "accepted" | "error";

export interface BrowserSubmissionDomEvidence {
  pageUrl: string;
  userMessageCount: number;
  assistantMessageCount: number;
  lastMessageRole: "assistant" | "user" | null;
  lastUserMessageHash: string | null;
  isAnswering: boolean;
}

export interface BrowserSubmissionComposerEvidence {
  state: ComposerPromptState | "empty";
  inlineTextLength: number;
  attachmentCount: number;
  pastedTextAttachmentPresent: boolean;
  sendButtonEnabled: boolean;
}

export interface BrowserSubmissionElementEvidence {
  tagName: string;
  role: string | null;
  ariaLabel: string | null;
  testId: string | null;
  id: string | null;
  className: string | null;
}

export interface BrowserSubmissionTargetEvidence {
  tabId: string | null;
  targetKind: "locator" | "coordinate";
  coordinate: { x: number; y: number };
  buttonRect: {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  elementFromPoint: BrowserSubmissionElementEvidence | null;
  elementFromPointButtonAncestor: BrowserSubmissionElementEvidence | null;
  elementFromPointMatchesButton: boolean;
  /** null means the IAB read-only DOM sandbox does not expose document.hasFocus(). */
  documentHasFocus: boolean | null;
  documentVisibilityState: string;
}

export interface BrowserTurnCheckpoint {
  /**
   * "staged" is a pre-click write-ahead of the composer state: the prompt is
   * provably present (possibly converted into an attachment) but no send click
   * has been attempted, so the turn's submission state must stay "requested".
   */
  submissionState: ControllerSubmissionState | "staged";
  composerPromptState: ComposerPromptState;
  conversationUrl?: string;
  selectedModelLabel: string;
  baselineAssistantMessageCount: number;
  runId?: string;
  round?: number;
  requestId?: string;
  promptHash?: string;
  modelEvidenceSource?: "composer";
  baselineUserMessageCount?: number;
  baselineLastUserMessageHash?: string | null;
  clickAttemptState?: ClickAttemptState;
  clickErrorName?: string;
  clickErrorMessage?: string;
  domEvidence?: BrowserSubmissionDomEvidence;
  composerEvidence?: BrowserSubmissionComposerEvidence;
  sendTargetEvidence?: BrowserSubmissionTargetEvidence;
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
  /** Observe a normally submitted turn without sending, including durable not-sent evidence. */
observeSubmittedTurn?(
input: BrowserTurnInput,
): Promise<BrowserSubmittedTurnObservation>;
/** Read-only proof that a submitted request landed in a different exact conversation. */
observeMisdirectedTurn?(
input: BrowserMisdirectedTurnObservationInput,
): Promise<BrowserMisdirectedTurnObservation>;
sendTurn(input: BrowserTurnInput, hooks?: BrowserTurnHooks): Promise<ControllerTurn>;
  recoverTurn?(input: BrowserTurnInput): Promise<ControllerTurn>;
  /** Archive one exact completed controller conversation. Implementations must never retry the archive click. */
  archiveConversation?(
    input: BrowserConversationArchiveInput,
    hooks?: BrowserConversationArchiveHooks,
  ): Promise<BrowserConversationArchiveEvidence>;
}
