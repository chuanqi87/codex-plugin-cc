import process from "node:process";

import { BRIDGE_BACKEND_ENV } from "./bridge-env.mjs";

import {
  buildPersistentTaskThreadName,
  DEFAULT_CONTINUE_PROMPT,
  findLatestTaskThread,
  getCodexAuthStatus,
  getCodexAvailability,
  getSessionRuntimeStatus,
  importExternalAgentSession,
  interruptAppServerTurn,
  parseStructuredOutput,
  readOutputSchema,
  runAppServerReview,
  runAppServerTurn
} from "./codex.mjs";
import {
  buildOpenCodeTaskThreadName,
  findLatestOpenCodeTaskSession,
  getOpenCodeAuthStatus,
  getOpenCodeAvailability,
  getOpenCodeSessionRuntimeStatus,
  runOpenCodeReview,
  runOpenCodeTask
} from "./opencode.mjs";

export { BRIDGE_BACKEND_ENV } from "./bridge-env.mjs";

const CODEX_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const CODEX_MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);

function normalizeCodexModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  return normalized ? (CODEX_MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized) : null;
}

function normalizeCodexReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!CODEX_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported Codex reasoning effort "${effort}". Use one of: ${[...CODEX_REASONING_EFFORTS].join(", ")}.`
    );
  }
  return normalized;
}

const CODEX_BACKEND = Object.freeze({
  id: "codex",
  displayName: "Codex",
  binaryName: "codex",
  sessionLabel: "Codex session ID",
  sessionColumnLabel: "Codex Session ID",
  setup: Object.freeze({
    installCommand: "npm install -g @openai/codex",
    loginCommand: "codex login",
    deviceLoginCommand: "codex login --device-auth",
    apiKeyLoginCommand: "codex login --with-api-key"
  }),
  capabilities: Object.freeze({
    auth: true,
    interrupt: true,
    review: true,
    sessionImport: true,
    task: true,
    threadResume: true
  }),
  defaultContinuePrompt: DEFAULT_CONTINUE_PROMPT,
  buildTaskThreadName: buildPersistentTaskThreadName,
  findLatestTaskThread,
  formatResumeCommand(threadId) {
    return `codex resume ${threadId}`;
  },
  async getAuthStatus(cwd, options = {}) {
    const status = await getCodexAuthStatus(cwd, options);
    return {
      ...status,
      required: status.requiresOpenaiAuth
    };
  },
  getAvailability: getCodexAvailability,
  getSessionRuntimeStatus,
  importSession: importExternalAgentSession,
  interruptTurn: interruptAppServerTurn,
  normalizeModel: normalizeCodexModel,
  normalizeReasoningEffort: normalizeCodexReasoningEffort,
  parseStructuredOutput,
  readOutputSchema,
  runReview: runAppServerReview,
  runTask: runAppServerTurn
});

function normalizeOpenCodeValue(value) {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}

const OPENCODE_BACKEND = Object.freeze({
  id: "opencode",
  displayName: "OpenCode",
  binaryName: "opencode",
  sessionLabel: "OpenCode session ID",
  sessionColumnLabel: "OpenCode Session ID",
  setup: Object.freeze({
    installCommand: "curl -fsSL https://opencode.ai/install | bash",
    loginCommand: "opencode auth login",
    deviceLoginCommand: "opencode auth login",
    apiKeyLoginCommand: "opencode auth login"
  }),
  capabilities: Object.freeze({
    auth: true,
    interrupt: false,
    review: true,
    sessionImport: false,
    task: true,
    threadResume: true
  }),
  defaultContinuePrompt: DEFAULT_CONTINUE_PROMPT,
  buildTaskThreadName: buildOpenCodeTaskThreadName,
  findLatestTaskThread: findLatestOpenCodeTaskSession,
  formatResumeCommand(threadId) {
    return `opencode --session ${threadId}`;
  },
  getAuthStatus: getOpenCodeAuthStatus,
  getAvailability: getOpenCodeAvailability,
  getSessionRuntimeStatus: getOpenCodeSessionRuntimeStatus,
  importSession: null,
  interruptTurn: null,
  normalizeModel: normalizeOpenCodeValue,
  normalizeReasoningEffort: normalizeOpenCodeValue,
  parseStructuredOutput,
  readOutputSchema,
  runReview: runOpenCodeReview,
  runTask: runOpenCodeTask
});

const BACKENDS = new Map([
  [CODEX_BACKEND.id, CODEX_BACKEND],
  [OPENCODE_BACKEND.id, OPENCODE_BACKEND]
]);

function supportedBackendIds() {
  return [...BACKENDS.keys()].join(", ");
}

export function listBackendAdapters() {
  return [...BACKENDS.values()];
}

export function resolveBackendAdapter(requestedId = null, env = process.env) {
  const id = String(requestedId ?? env[BRIDGE_BACKEND_ENV] ?? CODEX_BACKEND.id)
    .trim()
    .toLowerCase();
  const backend = BACKENDS.get(id);
  if (!backend) {
    throw new Error(`Unsupported agent backend "${id}". Available backends: ${supportedBackendIds()}.`);
  }
  return backend;
}

export function resolveBackendForJob(job, env = process.env) {
  return resolveBackendAdapter(job?.backendId ?? "codex", env);
}
