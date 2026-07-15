# Experiment: sanitized run timeline

Branch: `codex/exp-run-timeline`

## Hypothesis

Operators need an auditable chronological view without reading raw event
payloads that can contain controller prompts, tasks, stdout, stderr, or local
secrets.

## Surface

```bash
cueline run timeline <run-id> [--after <sequence>] [--limit <1..1000>] [--json]
```

The public API exports `loadCueLineRunTimeline()` and the pure
`buildCueLineRunTimeline()` formatter.

## Safety properties

- Pagination uses an exclusive durable event-sequence cursor.
- A cursor ahead of the run is rejected instead of returning a false empty page.
- Entries expose only allowlisted identity/status/model metadata.
- Prompt, request, task, output, error text, URL, and raw owner ID are excluded.
- Runtime owner IDs become 12-character one-way fingerprints.
- Payloads become canonical SHA-256 hashes for correlation, never raw JSON.
- Event types use an explicit known allowlist; unknown types are redacted.
- Invalid timestamps are replaced with `null`.
- Timeline reads never append events or claim ownership.

## Review decision

Merge if a safe audit view is worth maintaining an event-type allowlist. Reject
if direct local event-log access is preferred despite its disclosure risk.
