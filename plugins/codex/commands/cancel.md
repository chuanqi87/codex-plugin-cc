---
description: Cancel an active background bridge job in this repository
argument-hint: '[job-id] [--backend codex|opencode]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" cancel "$ARGUMENTS"`
