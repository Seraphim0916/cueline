# Controller conversation rollover

## Decision

CueLine keeps one durable `run_id` while allowing numbered ChatGPT Web conversation generations. Only one generation is active. A replaced generation is fenced permanently, so a late response from its URL cannot become a controller command.

The first production phase is operator-confirmed rollover. CueLine never infers exhaustion from a 90K/400K estimate, API context size, transcript length, elapsed time, or model prose. Generic delivery, usage, policy, authentication, browser, service, and model failures retain the current conversation.

## Shipped sequence

1. Require exactly one durably submitted pending controller turn and one exact predecessor URL.
2. Persist `controller_conversation_rotation_requested` with bounded evidence.
3. Verify the exact predecessor is idle; never use `Answer now` or stop generation.
4. Open a dedicated ChatGPT root tab without navigating the predecessor.
5. Persist `controller_conversation_replacement_opened`, fence and retain the predecessor, reset the Pin claim, and keep the same run and round.
6. Submit one fresh controller observation. Its durable submission checkpoint binds the successor URL.
7. Pin the successor independently, then persist `controller_conversation_rotation_activated`.

If opening fails before step 4 completes, the predecessor URL and pending turn remain authoritative. CueLine records the failure and performs no resend. Completion never unpins either generation, and archive remains a separate transaction.

## Invariants

- No guessed token threshold triggers rollover.
- One exact active conversation per run; concurrent runs have independent generations and Pins.
- Browser mutation follows durable intent.
- A predecessor pending turn is fenced before a successor turn is submitted.
- The successor uses a new request identity but the same durable run and round.
- No local command or job exists until a valid successor envelope is durably accepted.
- Generic timeout, usage/rate limit, policy refusal, auth failure, selector loss, service/model error, or unknown failure does not rotate.
- Old conversations are retained and never automatically unpinned or archived.

## Later phases

Automatic rollover requires versioned, locale-aware, context-specific Web evidence with zero false positives in shadow fixtures. Accepted-turn recovery must additionally preserve acceptance evidence, reject stale-generation envelopes, and prove one committed command across crash and late-response races. Until those gates pass, the explicit operator attestation is the only rollover trigger.
