# Agent Bridge architecture

The repository currently ships a Claude Code plugin backed by Codex. The runtime is being separated
into a reusable bridge so that the integration can grow into a matrix of host agents and execution
agents without duplicating job control, state, review targeting, or rendering.

## Boundary model

```text
Host adapter                 Bridge core                    Backend adapter
--------------------         --------------------------     ----------------------
Claude Code hooks      --->  jobs / state / git targets --> Codex app-server
Codex plugin skill           cancellation / progress        OpenCode JSON CLI
future other hosts           capability negotiation         future Qoder
                             result normalization
```

A **host** owns the user-facing session and supplies session identity or an exportable transcript.
A **backend** executes reviews and tasks, owns resumable agent threads, reports progress, and handles
backend-specific authentication and cancellation.

The two sides meet through capability checks. A combination may run tasks even when it cannot import
a complete session, and the bridge must reject unsupported operations explicitly instead of emulating
them with lossy prompt concatenation.

## Implemented contracts

- `lib/host-adapters.mjs` registers Claude Code and Codex host identity plus optional session-export behavior.
- `lib/backend-adapters.mjs` registers execution, review, resume, import, interrupt, and setup behavior.
- `lib/bridge-context.mjs` resolves a host/backend pair from CLI flags or environment variables and
  performs capability checks.
- Job records persist `hostId` and `backendId`. Legacy records without these fields resolve to the
  original Claude Code + Codex pairing.
- `AGENT_BRIDGE_HOST`, `AGENT_BRIDGE_BACKEND`, and `AGENT_BRIDGE_SESSION_ID` are the neutral runtime
  variables. `CODEX_COMPANION_SESSION_ID` remains supported for compatibility.

The internal CLI exposes the installed matrix:

```bash
node plugins/codex/scripts/codex-companion.mjs adapters
node plugins/codex/scripts/codex-companion.mjs task --host claude-code --backend codex "review the failure"
```

Only adapters with working implementations are registered. Codex and OpenCode are available now;
Qoder remains unregistered until its stream protocol and permission mappings have contract tests.

## Backend contract

Every backend must define stable identity and capabilities, plus implementations for the capabilities
it enables:

- availability and authentication checks;
- task execution with read-only and workspace-write permission mapping;
- review execution or a deliberate review-via-task implementation;
- progress events normalized to bridge phases;
- resumable thread discovery and an exact resume command;
- cooperative turn interruption where supported;
- optional external-session import.

Backend output must normalize to the existing execution result shape: exit status, thread and turn
identifiers, final message, touched files, reasoning summary, and error detail. Process exit alone is
not enough when a backend exposes a structured event stream.

## Host contract

Every host must provide:

- a stable host ID and display name;
- current session identity when the host exposes it;
- lifecycle cleanup integration when the host supports hooks;
- a typed session export containing a format ID, source path or payload, and source session ID.

Host-specific commands and packaging stay outside the bridge core. This repository can continue to
ship the `codex` Claude Code plugin while another package supplies the same bridge to a Codex host.

For Codex as a host, a separate Codex plugin wraps the bridge with a skill. When richer typed control
is needed, it can add a local MCP server. Do not try to make one manifest serve both Claude Code and
Codex: the shared unit is the bridge runtime, while each host owns its native packaging.
Codex plugins can bundle reusable skills and connectors/MCP tools across supported Codex surfaces.

Reference: [Codex and ChatGPT plugins](https://learn.chatgpt.com/docs/plugins).

## OpenCode adapter

The implemented adapter uses non-interactive `opencode run --format json` and normalizes session,
message, reasoning, tool, error, and file events into the bridge result. It supports task execution,
review-via-task, model and variant selection, persistent session resume, foreground execution, and the
shared background job lifecycle.

`opencode-process.mjs` owns process streaming and stdin delivery. `opencode-events.mjs` selects the
last assistant message, distinguishes tool steps from terminal completion, records successful file
tool metadata, and bounds malformed-line diagnostics. Reasoning requires the CLI's `--thinking`
flag. A successful process exit without a completed final message is a failed bridge run.

`opencode-review.mjs` collects inline Git evidence with a 512 KiB limit for the shell-denied review
agent. Both review paths and the stop gate use this collector; they reject an oversized context
instead of asking the agent to run Git or silently dropping the diff. The adapter's optional
`collectReviewContext` method lets other backends keep their own context strategy. Structured output
schemas are supplied in the prompt and validated locally against the bundled schema assertions;
this CLI path does not claim native constrained generation.

The bridge injects a uniquely named OpenCode agent through `OPENCODE_CONFIG_CONTENT` for each run.
Read-only runs deny edits, delegated tasks, external-directory access, shell commands, and unlisted
custom/MCP tools; OpenCode's built-in read/search tools remain available. Write runs allow edits and
shell commands for implementation and verification, while denying delegated tasks and interactive
questions. Both modes use the workspace permission
policy and never pass the dangerous `--auto` permission flag. This is OpenCode's permission layer, not
an operating-system sandbox. Existing inline OpenCode configuration is preserved when valid.

OpenCode session import is deliberately disabled: its import command accepts OpenCode exports, not a
Claude Code transcript contract. Protocol-level turn interruption is also disabled for the one-shot
adapter; background cancellation terminates the worker process tree. A later long-lived server adapter
can add cooperative cancellation. The V2 embedded SDK is attractive for that follow-up, but its
official docs still mark it beta.

Resume candidates are filtered by explicit workspace directory, root-session identity, archive
state, and bridge task title, then sorted by update time. Missing host/backend job fields resolve to
Claude Code/Codex when filtering as well as when executing a stored job.

Validation covers real CLI-shaped fixtures for success, multi-step responses, errors with exit zero,
incomplete output, long stdin prompts, schema failures, cancellation, review evidence, and resume
isolation. Local smoke checks with OpenCode 1.18.27 use an isolated OpenAI-compatible HTTP test
provider to exercise the actual CLI and session database without provider credentials.

References: [OpenCode CLI](https://dev.opencode.ai/docs/cli/),
[OpenCode V2 SDK](https://opencode.ai/v2/docs/build/sdk).

## Qoder adapter direction

Qoder exposes headless execution with JSON or stream-JSON output, explicit working directory, model,
permission mode, and session ID controls. It also exposes ACP mode. The first adapter can use the
stream-JSON process protocol and map bridge read-only/write modes to Qoder permissions; ACP is the
better follow-up when interactive permission requests and richer lifecycle control are needed.

References: [Qoder headless mode](https://docs.qoder.com/cli/run-in-scripts),
[Qoder CLI reference](https://docs.qoder.com/cli/cli-reference).

## Delivery sequence

1. Keep the existing Claude Code + Codex adapter as the compatibility reference and contract-test it.
2. Extract generic progress/result event types from the Codex app-server implementation.
3. Add OpenCode as the second backend, including fake-CLI integration tests for resume, permissions,
   progress, review, and capability rejection. **Complete.**
4. Extend the common backend contract suite with cancellation and failure fixtures, then apply it to
   both Codex and OpenCode.
5. Add Qoder as the third backend with a fake stream-JSON fixture and the same contract suite.
6. Package a second host integration only after the backend contract has survived both adapters.
7. Rename the distribution and user-facing commands only in a versioned migration; do not make core
   reuse depend on a breaking marketplace rename.

The key product rule is that **task delegation**, **review**, **session transfer**, and **resume** are
separate capabilities. A universal bridge should expose the strongest safe subset for each pairing,
not claim that every agent can reproduce every other agent's private session format.
