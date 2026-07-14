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
}

export interface BrowserAdapter {
  sendTurn(input: BrowserTurnInput): Promise<ControllerTurn>;
}
