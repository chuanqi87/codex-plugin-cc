import process from "node:process";

import { BRIDGE_HOST_ENV, BRIDGE_SESSION_ID_ENV, LEGACY_SESSION_ID_ENV } from "./bridge-env.mjs";
import { resolveClaudeSessionPath } from "./claude-session-transfer.mjs";

export { BRIDGE_HOST_ENV, BRIDGE_SESSION_ID_ENV, LEGACY_SESSION_ID_ENV } from "./bridge-env.mjs";

const CLAUDE_CODE_HOST = Object.freeze({
  id: "claude-code",
  displayName: "Claude Code",
  stopReviewTaskMarker: "Run a stop-gate review of the previous Claude turn.",
  capabilities: Object.freeze({
    lifecycleHooks: true,
    sessionExport: true,
    sessionIdentity: true
  }),
  getSessionId(env = process.env) {
    return env[BRIDGE_SESSION_ID_ENV] ?? env[LEGACY_SESSION_ID_ENV] ?? null;
  },
  resolveSessionExport(cwd, options = {}) {
    const sourcePath = resolveClaudeSessionPath(cwd, options);
    return {
      format: "claude-code-jsonl",
      sourcePath,
      sourceSessionId: options.sessionId ?? null
    };
  }
});

const CODEX_HOST = Object.freeze({
  id: "codex",
  displayName: "Codex",
  stopReviewTaskMarker: null,
  capabilities: Object.freeze({
    lifecycleHooks: false,
    sessionExport: false,
    sessionIdentity: true
  }),
  getSessionId(env = process.env) {
    return env[BRIDGE_SESSION_ID_ENV] ?? env.CODEX_THREAD_ID ?? env.CODEX_SESSION_ID ?? null;
  },
  resolveSessionExport: null
});

const HOSTS = new Map([
  [CLAUDE_CODE_HOST.id, CLAUDE_CODE_HOST],
  [CODEX_HOST.id, CODEX_HOST]
]);

function supportedHostIds() {
  return [...HOSTS.keys()].join(", ");
}

export function listHostAdapters() {
  return [...HOSTS.values()];
}

export function resolveHostAdapter(requestedId = null, env = process.env) {
  const id = String(requestedId ?? env[BRIDGE_HOST_ENV] ?? CLAUDE_CODE_HOST.id)
    .trim()
    .toLowerCase();
  const host = HOSTS.get(id);
  if (!host) {
    throw new Error(`Unsupported host adapter "${id}". Available hosts: ${supportedHostIds()}.`);
  }
  return host;
}
