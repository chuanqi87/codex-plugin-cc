---
description: Check whether a local execution backend is ready and optionally toggle the stop-time review gate
argument-hint: '[--backend codex|opencode] [--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If the selected backend is Codex and the result says it is unavailable while npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @openai/codex
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If the selected backend is OpenCode and unavailable, present the install command from the setup report; do not run a remote install script automatically.

If the selected backend is already installed, or its installer cannot be offered safely:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- Preserve the selected backend's authentication or provider guidance exactly as reported.
