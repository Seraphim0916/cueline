# Multi-model routing

## What ships by default

CueLine ships one enabled lane, `default`, with one candidate, `codex-default`. That candidate runs the bundled `codex exec --ignore-user-config` process route when process execution is explicitly authorized.

Process execution is not the default. `startCueLineRun` and `runCueLine` default to `executor: "caller"`, which spawns no worker process at all. A controller dispatch is persisted and handed back to the current Codex for execution. Multi-model process routing is therefore an opt-in user configuration, not a CueLine code change.

A ready-to-adopt starter ships at `config/routing.multimodel.example.json`: it keeps the bundled Codex `work` route on `default` and adds two advise-only lanes that call provider CLIs directly — `claude-opus-4-8-advise` on `taste-final` and `grok-advise-search` on `live-search` — so anyone with `codex` plus `claude` or `grok` on `PATH` can enable additional providers by pointing `CUELINE_CONFIG` at it, no wrapper script required. The native Grok candidate relies on `-p`/`--verbatim`/`--permission-mode plan` (verified against grok `0.2.103`); it inherits the CueLine process environment, so an exported `XAI_API_KEY` silently switches billing from the CLI login to that key — use the wrapper variant below to unset it. The four-lane configuration later in this document extends that pattern with Gemini and Grok through wrapper scripts.

## What the controller can see

For a process run, CueLine builds a routing instruction before every controller turn. ChatGPT Pro sees only:

- enabled lane names;
- enabled, currently available candidate IDs inside each lane.

The controller never sees candidate `argv`, executable paths, wrapper contents, environment handling, or flags such as `--model`. It may select a lane and may name one advertised candidate with the optional `runner` field. CueLine validates that choice locally before any process starts.

Candidate IDs are therefore the controller's menu. Encode both the model and intended purpose in each ID so the choice remains meaningful without exposing implementation details:

- `claude-opus-4-8-advise`
- `gemini-3-1-pro-advise`
- `grok-4-5-advise-search`

Keep IDs stable after they are used in durable runs. Change the `argv` behind an ID only when the new command preserves the same intended contract; otherwise add a new candidate ID.

## Known limitations and wrapper boundaries

The following constraints were verified against CueLine `0.1.7` and working local multi-model runners on 2026-07-16.

### Candidates cannot define environment variables

The routing schema accepts `id`, `argv`, `task_input`, and `enabled`. It has no `env` field.

A worker CLI that requires environment setup must therefore use a wrapper script as `argv[0]`. For example, the Antigravity `agy` CLI needs `NO_BROWSER=1` for headless execution and should have API-key variables removed when the intended path is the existing CLI login. A wrapper can establish that environment before replacing itself with the real worker process.

Keep secrets out of the routing JSON and wrapper source. Wrappers should unset conflicting variable names or inherit an already authorized local login; they should not embed credential values.

### Candidate argv cannot branch on `advise` versus `work`

CueLine expands fixed placeholders inside individual argv elements. `{mode}` expands to the literal `advise` or `work`. `{sandbox}` is the only mode-derived argument value: it expands to `read-only` for `advise` and `workspace-write` for `work`. Those values are designed for the Codex sandbox flag and are not a portable permission contract for other CLIs.

The routing format has no conditional expression that can select one argv sequence for `advise` and another for `work`. For non-Codex workers, prefer an advise-only lane:

- Claude: hardcode `--tools Read Glob Grep`.
- Antigravity: hardcode `--mode plan`.
- Grok: hardcode `--permission-mode plan`.

Keep mutating `work` jobs on the bundled `default` lane unless a separate worker has an independently verified work-mode permission contract.

### Registration is not a sandbox

The runner contract states:

> Registration is an allow-list, not a sandbox: the registered program still has the OS permissions of the local CueLine process.

CueLine verifies that `argv[0]` came from the loaded routing configuration and launches it without a shell. That prevents the controller from supplying an arbitrary executable, but it does not reduce the executable's operating-system permissions.

A registered non-Codex worker therefore runs with the full OS permissions of the local CueLine process. Its read-only behavior depends entirely on the CLI flags, wrapper behavior, credentials, and working directory chosen by the user.

## Worked four-lane configuration

This example keeps `work` on the bundled Codex route and adds three advise-only lanes:

- `taste-final`: Claude Opus for final prose and judgment;
- `long-context`: Gemini through an Antigravity wrapper;
- `live-search`: Grok through a live-search wrapper.

Create a private runner directory and replace `/absolute/path/to/cueline-runners` below with its real absolute path. Do not use `$HOME` or `~` inside JSON; CueLine passes argv directly and does not perform shell expansion.

### Routing configuration

```json
{
  "$schema": "/absolute/path/to/cueline/config/routing.schema.json",
  "version": 1,
  "lanes": {
    "default": {
      "enabled": true,
      "candidates": [
        {
          "id": "codex-default",
          "argv": [
            "codex",
            "exec",
            "--ignore-user-config",
            "--skip-git-repo-check",
            "--ephemeral",
            "--color",
            "never",
            "-C",
            "{workdir}",
            "-s",
            "{sandbox}",
            "-"
          ],
          "task_input": "stdin"
        }
      ]
    },
    "taste-final": {
      "enabled": true,
      "candidates": [
        {
          "id": "claude-opus-4-8-advise",
          "argv": [
            "claude",
            "--disable-slash-commands",
            "--model",
            "claude-opus-4-8",
            "--output-format",
            "text",
            "--effort",
            "high",
            "--tools",
            "Read",
            "Glob",
            "Grep",
            "-p",
            "{task}"
          ],
          "task_input": "argv"
        }
      ]
    },
    "long-context": {
      "enabled": true,
      "candidates": [
        {
          "id": "gemini-3-1-pro-advise",
          "argv": [
            "/absolute/path/to/cueline-runners/gemini-advise.sh",
            "Gemini 3.1 Pro (High)"
          ],
          "task_input": "stdin"
        }
      ]
    },
    "live-search": {
      "enabled": true,
      "candidates": [
        {
          "id": "grok-4-5-advise-search",
          "argv": [
            "/absolute/path/to/cueline-runners/grok-advise.sh",
            "grok-4.5"
          ],
          "task_input": "stdin"
        }
      ]
    }
  }
}
```

The `$schema` path is editor metadata; set it to the installed or checked-out `routing.schema.json` when schema-aware validation is desired. CueLine validates the routing object independently at load time.

### Gemini wrapper

Save as `gemini-advise.sh` and make it executable:

```bash
#!/usr/bin/env bash
# CueLine advise-only Gemini runner through Antigravity.
# argv: gemini-advise.sh "<agy model display string>"; task arrives on stdin.
set -euo pipefail

MODEL="${1:-Gemini 3.1 Pro (High)}"
TASK="$(cat)"

# Stay on the existing CLI login and avoid browser interaction.
exec env -u GEMINI_API_KEY -u GOOGLE_API_KEY -u GOOGLE_AI_API_KEY \
  NO_BROWSER=1 \
  agy --dangerously-skip-permissions --add-dir "$PWD" \
  --mode plan --model "$MODEL" \
  --print-timeout 570s \
  --print "$TASK"
```

`--dangerously-skip-permissions` disables Antigravity's interactive permission prompts; it does not make the process read-only. The enforced read-only intent in this wrapper comes from `--mode plan`. Verify that contract against the installed `agy` version before registering it.

### Grok wrapper

Save as `grok-advise.sh` and make it executable:

```bash
#!/usr/bin/env bash
# CueLine advise-only Grok runner for live web and X search.
# argv: grok-advise.sh "<model>"; task arrives on stdin.
set -euo pipefail

MODEL="${1:-grok-4.5}"

TMP="$(mktemp)"
trap '{ rm -- "$TMP"; } 2>/dev/null || true' EXIT
cat > "$TMP"

# Keep the subscription login path when an API-key variable would override it.
unset XAI_API_KEY 2>/dev/null || true

grok --cwd "$PWD" --model "$MODEL" \
  --no-memory --no-subagents --no-plan --no-alt-screen \
  --output-format plain --verbatim --permission-mode plan \
  --prompt-file "$TMP"
```

Make both wrappers executable:

```bash
chmod 700 /absolute/path/to/cueline-runners/gemini-advise.sh
chmod 700 /absolute/path/to/cueline-runners/grok-advise.sh
```

### Verify the routing file

Point `CUELINE_CONFIG` at the completed file and inspect it through CueLine's real routing surface:

```bash
CUELINE_CONFIG=/absolute/path/to/routing.multimodel.json \
  cueline routing --json
```

The command validates the file and checks whether each candidate's `argv[0]` is executable in the current environment. A valid file has this output shape:

```json
{
  "version": "0.1.7",
  "config": {
    "path": "/absolute/path/to/routing.multimodel.json",
    "valid": true
  },
  "availableLanes": 4,
  "lanes": [
    {
      "name": "default",
      "enabled": true,
      "status": "available",
      "selectedRunnerId": "codex-default"
    }
  ],
  "findings": []
}
```

The real `lanes` array contains one entry per configured lane. `availableLanes` may be less than four, and individual lanes may report `status: "unavailable"`, when a CLI or wrapper is not executable on the current `PATH` or at the configured absolute path. That is an availability result, not a schema-validation failure.

Use the same `CUELINE_CONFIG` value when creating and continuing the process run. Process execution still requires both `executor: "process"` and `allowProcessExecution: true`.

## What the controller sees

With all four candidates available, the per-round routing instruction includes a line shaped like:

```text
Available routing lanes: default [codex-default]; taste-final [claude-opus-4-8-advise]; long-context [gemini-3-1-pro-advise]; live-search [grok-4-5-advise-search].
```

That is the complete routing menu exposed to ChatGPT Pro. The wrapper paths, CLI arguments, model flags, environment cleanup, and permission flags remain local.

## Work-capable workers with permission prompts bypassed

The advise-only candidates above are the safe default. When the operator explicitly wants non-Codex workers to execute mutating `work` jobs, the blocking problem is interactive approval: agent CLIs stop and wait for a permission prompt that no one will answer inside a spawned runner. The bypass flags remove that gate — and with it every other approval gate.

Understand the contract before registering any of these:

- Registration is not a sandbox. A bypass-permission worker mutates whatever the dispatched task tells it to, with the full OS permissions of the CueLine process.
- The routing format cannot branch argv on `advise` versus `work`, so a bypass candidate treats every job as mutating regardless of mode. Keep an advise-only candidate alongside it and encode the difference in the candidate ID.
- The controller only ever sees candidate IDs, so make the risk visible in the ID (`-work` suffix here) and never reuse an advise ID for a bypass argv.

Reference wrappers ship in `examples/runners/` (repository only, not part of the npm package):

- `examples/runners/grok-work.sh` — native `grok` with `--permission-mode bypassPermissions`; unsets `XAI_API_KEY` to keep the CLI subscription login; task on stdin.
- `examples/runners/gemini-work.sh` — Gemini through the Antigravity `agy` CLI with `--dangerously-skip-permissions`; establishes `NO_BROWSER=1` and strips API-key variables; task on stdin.

Claude needs no wrapper; the work candidate is a direct sibling of the shipped advise candidate:

```json
{
  "id": "claude-sonnet-5-work",
  "argv": [
    "claude",
    "--disable-slash-commands",
    "--model",
    "claude-sonnet-5",
    "--output-format",
    "text",
    "--dangerously-skip-permissions",
    "-p",
    "{task}"
  ],
  "task_input": "argv"
}
```

Copy the wrappers to a private runner directory, `chmod 700` them, and register them by absolute path, exactly as in the four-lane example. Verify with `cueline routing --json`, then send each worker a one-line task through its wrapper directly before trusting it inside a run.

The grok and claude work candidates were verified end-to-end (one-line task, correct reply) against grok `0.2.103` and claude `2.1.215` on 2026-07-19. The gemini wrapper reuses the flag contract of the advise wrapper verified on 2026-07-16, but its end-to-end check against agy `1.1.4` timed out on 2026-07-19 — every headless `agy --print` variant did, including the previously working one — so treat it as unverified until a one-line task round-trips on the installed agy.
