# Changelog

## 1.0.7

- Supply actual Git evidence to OpenCode normal, adversarial, and stop-gate reviews.
- Stream large prompts through stdin and validate structured review responses locally.
- Track final responses, reasoning logs, completion failures, and successful file-tool changes using
  OpenCode's CLI JSON event protocol.
- Isolate resume and status selection across hosts, backends, and workspaces, including legacy jobs.
- Deny unlisted tools in read-only runs and enable shell verification for explicit write tasks.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
