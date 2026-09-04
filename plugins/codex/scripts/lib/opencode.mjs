import { spawn } from "node:child_process";
import process from "node:process";

import { createOpenCodeEventCollector } from "./opencode-events.mjs";
import { buildOpenCodeEnvironment } from "./opencode-policy.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";

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

function runOpenCodeProcess(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", args, {
      cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdoutBuffer = "";
    let stderr = "";
    const collector = createOpenCodeEventCollector({ onProgress: options.onProgress });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        collector.consumeLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      collector.consumeLine(stdoutBuffer);
      resolve({
        code: code ?? (signal ? 1 : 0),
        signal,
        stderr: stderr.trim(),
        ...collector.result()
      });
    });
  });
}

function buildRunArgs(cwd, options, prompt, agentName) {
  const args = ["run", "--format", "json", "--dir", cwd, "--agent", agentName];
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
  args.push(prompt);
  return args;
}

export async function runOpenCodeTask(cwd, options = {}) {
  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this OpenCode run.");
  }
  const { agentName, env } = buildOpenCodeEnvironment(options.sandbox, options.env ?? process.env);
  emitProgress(options.onProgress, options.resumeThreadId ? `Resuming OpenCode session ${options.resumeThreadId}.` : "Starting OpenCode task session.", "starting", {
    threadId: options.resumeThreadId ?? null
  });
  const execution = await runOpenCodeProcess(cwd, buildRunArgs(cwd, options, prompt, agentName), {
    env,
    onProgress: options.onProgress
  });
  const failure = execution.errorMessage || (execution.code !== 0 ? execution.stderr || `OpenCode exited with status ${execution.code}.` : "");
  const invalidOutput = execution.invalidLines.length > 0 ? execution.invalidLines.join("\n") : "";
  return {
    status: failure ? execution.code || 1 : 0,
    threadId: execution.threadId ?? options.resumeThreadId ?? null,
    turnId: null,
    finalMessage: execution.finalMessage,
    reasoningSummary: execution.reasoningSummary,
    error: failure ? new Error(failure) : null,
    stderr: [execution.stderr, invalidOutput].filter(Boolean).join("\n"),
    touchedFiles: execution.touchedFiles
  };
}

function buildReviewPrompt(target) {
  if (target?.type === "baseBranch") {
    return `Review the current branch against base branch ${target.branch}. Focus on concrete correctness, security, and regression risks. Return concise findings with file and line references; if there are no material findings, say so explicitly.`;
  }
  return "Review the current uncommitted changes. Focus on concrete correctness, security, and regression risks. Return concise findings with file and line references; if there are no material findings, say so explicitly.";
}

export async function runOpenCodeReview(cwd, options = {}) {
  const result = await runOpenCodeTask(cwd, {
    ...options,
    prompt: buildReviewPrompt(options.target),
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
  return (Array.isArray(sessions) ? sessions : []).find((session) =>
    typeof session.title === "string" && session.title.startsWith(TASK_THREAD_PREFIX) && (!session.directory || session.directory === cwd)
  ) ?? null;
}

export function buildOpenCodeTaskThreadName(prompt) {
  const excerpt = shorten(prompt);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

export { TASK_THREAD_PREFIX as OPENCODE_TASK_THREAD_PREFIX };
