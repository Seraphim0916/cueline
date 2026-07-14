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

export interface BrowserAdapter {
  sendTurn(input: BrowserTurnInput): Promise<ControllerTurn>;
}
