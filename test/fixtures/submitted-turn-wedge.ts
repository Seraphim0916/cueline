export const submittedTurnWedgeFixture = {
  schema: "cueline-deidentified-submitted-wedge/0.1",
  sourceRunId: "run_2707dc7332cd6d6f9c5c3d5cf21a33fd",
  sourceRequestId: "msg_ff0ca58c1f64ce58941299b73e61715f",
  fixtureRunId: "run_submitted_turn_wedge",
  round: 34,
  priorVisibleRound: 33,
  baselineUserMessageCount: 50,
  conversationUrl: "https://chatgpt.com/c/deidentified-submitted-turn-wedge",
  prompt: "Round 34 controller prompt that never reached the conversation.",
  staleReconciliation: {
    round: 11,
    abandonedRequestId: "msg_4de_stale_round_11",
    retryRequestId: "msg_1e83_stale_round_11_retry",
  },
} as const;
