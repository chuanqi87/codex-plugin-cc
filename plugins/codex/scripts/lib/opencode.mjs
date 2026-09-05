import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { buildOpenCodeEnvironment } from "./opencode-policy.mjs";
import { runOpenCodeProcess } from "./opencode-process.mjs";
import { buildOpenCodeReviewPrompt, collectOpenCodeReviewContext } from "./opencode-review.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";
import { validateStructuredOutput } from "./structured-output.mjs";

const TASK_THREAD_PREFIX = "Agent Bridge Task";

function shorten(text, limit = 56) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function emitProgress(onProgress, message, phase, extra = {}) {
  onProgress?.({ message, phase, ...extra });
}

function buildRunArgs(cwd, options, agentName) {
  const args = ["run", "--format", "json", "--thinking", "--dir", cwd, "--agent", agentName];
  if (options.resumeThreadId) {
    args.push("--session", options.resumeThreadId);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.effort) {
    args.push("--variant", options.effort);
  }
  if (!options.resumeThreadId && options.threadName) {
    args.push("--title", options.threadName);
  }
  return args;
}

export async function runOpenCodeTask(cwd, options = {}) {
  let prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this OpenCode run.");
  }
  if (options.outputSchema) {
    prompt += `\n\nReturn only valid JSON matching this JSON Schema:\n${JSON.stringify(options.outputSchema)}`;
  }
  const { agentName, env } = buildOpenCodeEnvironment(options.sandbox, options.env ?? process.env);
  emitProgress(options.onProgress, options.resumeThreadId ? `Resuming OpenCode session ${options.resumeThreadId}.` : "Starting OpenCode task session.", "starting", {
    threadId: options.resumeThreadId ?? null
  });
  const execution = await runOpenCodeProcess(cwd, buildRunArgs(cwd, options, agentName), {
    env,
    prompt,
    threadId: options.resumeThreadId,
    onProgress: options.onProgress
  });
  let failure = execution.errorMessage || (execution.code !== 0 ? execution.stderr || `OpenCode exited with status ${execution.code}.` : "");
  failure ||= execution.inputError ? `Unable to send the complete OpenCode prompt: ${execution.inputError.message}` : "";
  failure ||= !execution.finalMessage ? "OpenCode exited without a final assistant response." : "";
  failure ||= !execution.completed ? "OpenCode exited before completing the response. The output may be partial; inspect the session before resuming." : "";
  if (!failure && options.outputSchema) {
    failure = validateStructuredOutput(execution.finalMessage, options.outputSchema);
  }
  emitProgress(options.onProgress, failure || "OpenCode session completed.", failure ? "failed" : "finalizing", {
    threadId: execution.threadId,
    logTitle: "Final output",
    logBody: execution.finalMessage
  });
  const invalidOutput = execution.invalidLines.length > 0 ? execution.invalidLines.join("\n") : "";
  return {
    status: failure ? execution.code || 1 : 0,
    threadId: execution.threadId ?? options.resumeThreadId ?? null,
    turnId: null,
    finalMessage: execution.finalMessage,
    reasoningSummary: execution.reasoningSummary,
    error: failure ? new Error(failure) : null,
    stderr: [...new Set([failure, execution.stderr, invalidOutput].filter(Boolean))].join("\n"),
    touchedFiles: execution.touchedFiles
  };
}

export async function runOpenCodeReview(cwd, options = {}) {
  const target = options.target?.type === "baseBranch"
    ? { mode: "branch", baseRef: options.target.branch, label: `branch diff against ${options.target.branch}` }
    : { mode: "working-tree", label: "working tree diff" };
  const context = collectOpenCodeReviewContext(cwd, target);
  const result = await runOpenCodeTask(context.repoRoot, {
    ...options,
    prompt: buildOpenCodeReviewPrompt(context),
    sandbox: "read-only",
    threadName: "Agent Bridge Review"
  });
  return {
    ...result,
    sourceThreadId: result.threadId,
    reviewText: result.finalMessage
  };
}

export function getOpenCodeAvailability(cwd) {
  return binaryAvailable("opencode", ["--version"], { cwd });
}

export async function getOpenCodeAuthStatus(cwd) {
  const availability = getOpenCodeAvailability(cwd);
  if (!availability.available) {
    return {
      loggedIn: false,
      required: false,
      authMethod: null,
      source: "opencode",
      detail: availability.detail
    };
  }
  const result = runCommand("opencode", ["auth", "list"], { cwd });
  return {
    loggedIn: true,
    required: false,
    authMethod: null,
    source: "opencode",
    detail: result.status === 0
      ? "Provider credentials are managed by OpenCode; the selected provider is validated when a task starts."
      : (result.stderr.trim() || result.stdout.trim() || "Provider readiness will be validated when a task starts.")
  };
}

export function getOpenCodeSessionRuntimeStatus() {
  return {
    mode: "process",
    label: "per-task OpenCode process",
    endpoint: null,
    healthy: true
  };
}

export async function findLatestOpenCodeTaskSession(cwd) {
  const result = runCommand("opencode", ["session", "list", "--format", "json", "--max-count", "50"], { cwd });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Unable to list OpenCode sessions.");
  }
  let sessions;
  try {
    sessions = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`OpenCode returned invalid session JSON: ${error.message}`);
  }
  if (!Array.isArray(sessions)) {
    throw new Error("OpenCode returned invalid session JSON: expected a session array.");
  }
  const directory = canonicalDirectory(cwd);
  return sessions.filter((session) =>
    typeof session?.id === "string" && session.id && !session.parentID && !session.time?.archived &&
    typeof session.title === "string" &&
    (session.title === TASK_THREAD_PREFIX || session.title.startsWith(`${TASK_THREAD_PREFIX}: `)) &&
    typeof session.directory === "string" && path.isAbsolute(session.directory) && canonicalDirectory(session.directory) === directory
  ).sort((left, right) => sessionUpdatedAt(right) - sessionUpdatedAt(left))[0] ?? null;
}

function canonicalDirectory(directory) {
  try {
    return fs.realpathSync(directory);
  } catch {
    return path.resolve(directory);
  }
}

function sessionUpdatedAt(session) {
  const value = session.time?.updated ?? session.updated ?? 0;
  return typeof value === "number" ? value : Date.parse(value) || 0;
}

export function buildOpenCodeTaskThreadName(prompt) {
  const excerpt = shorten(prompt);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

export { TASK_THREAD_PREFIX as OPENCODE_TASK_THREAD_PREFIX };
