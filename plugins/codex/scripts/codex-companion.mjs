#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { listBackendAdapters, resolveBackendForJob } from "./lib/backend-adapters.mjs";
import { assertBridgeCapability, resolveBridgeContext } from "./lib/bridge-context.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { listHostAdapters } from "./lib/host-adapters.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs adapters [--json]",
      "  node scripts/codex-companion.mjs setup [--host <id>] [--backend <id>] [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--host <id>] [--backend <id>] [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--host <id>] [--backend <id>] [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--host <id>] [--backend <id>] [--background] [--write] [--resume-last|--resume|--fresh] [--model <model>] [--effort <value>] [prompt]",
      "  node scripts/codex-companion.mjs transfer [--host <id>] [--backend <id>] [--source <session-export>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function buildAdapterReport() {
  return {
    hosts: listHostAdapters().map(({ id, displayName, capabilities }) => ({ id, displayName, capabilities })),
    backends: listBackendAdapters().map(({ id, displayName, capabilities }) => ({ id, displayName, capabilities }))
  };
}

function renderAdapterReport(report) {
  const lines = ["# Agent Bridge Adapters", "", "Hosts:"];
  for (const host of report.hosts) {
    lines.push(`- ${host.id}: ${host.displayName}`);
  }
  lines.push("", "Backends:");
  for (const backend of report.backends) {
    const capabilities = Object.entries(backend.capabilities)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .join(", ");
    lines.push(`- ${backend.id}: ${backend.displayName} (${capabilities})`);
  }
  return `${lines.join("\n")}\n`;
}

function handleAdapters(argv) {
  const { options } = parseCommandInput(argv, {
    booleanOptions: ["json"]
  });
  const report = buildAdapterReport();
  outputCommandResult(report, renderAdapterReport(report), options.json);
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = [], context = resolveBridgeContext()) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const backendStatus = context.backend.getAvailability(cwd);
  const authStatus = await context.backend.getAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!backendStatus.available) {
    nextSteps.push(`Install ${context.backend.displayName} with \`${context.backend.setup.installCommand}\`.`);
  }
  if (backendStatus.available && !authStatus.loggedIn && authStatus.required) {
    nextSteps.push(`Run \`!${context.backend.setup.loginCommand}\`.`);
    nextSteps.push(
      `If browser login is blocked, retry with \`!${context.backend.setup.deviceLoginCommand}\` or \`!${context.backend.setup.apiKeyLoginCommand}\`.`
    );
  }
  if (!config.stopReviewGate) {
    nextSteps.push(
      `Optional: run \`/codex:setup --backend ${context.backend.id} --enable-review-gate\` to require a fresh review before stop.`
    );
  }

  return {
    ready: nodeStatus.available && backendStatus.available && authStatus.loggedIn,
    host: { id: context.host.id, displayName: context.host.displayName },
    backend: { id: context.backend.id, displayName: context.backend.displayName },
    node: nodeStatus,
    npm: npmStatus,
    backendStatus,
    ...(context.backend.id === "codex" ? { codex: backendStatus } : {}),
    auth: authStatus,
    sessionRuntime: context.backend.getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    reviewGateBackendId: config.stopReviewBackendId ?? "codex",
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "host", "backend"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const context = resolveBridgeContext(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    setConfig(workspaceRoot, "stopReviewBackendId", context.backend.id);
    actionsTaken.push(`Enabled the ${context.backend.displayName} stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken, context);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureBackendAvailable(cwd, context) {
  const availability = context.backend.getAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      `${context.backend.displayName} is not installed or is missing required runtime support. Install it with \`${context.backend.setup.installCommand}\`, then rerun setup.`
    );
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentHostSessionId(context) {
  return context.host.getSessionId(process.env);
}

function filterJobsForBridgeContext(jobs, context) {
  const sessionId = getCurrentHostSessionId(context);
  const scopedJobs = jobs.filter(
    (job) =>
      (job.hostId ?? "claude-code") === context.host.id &&
      (job.backendId ?? "codex") === context.backend.id
  );
  if (!sessionId) {
    return scopedJobs;
  }
  return scopedJobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, context, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentHostSessionId(context);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForBridgeContext(jobs, context);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return context.backend.findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  const bridge = request.bridgeContext ?? resolveBridgeContext({ host: request.hostId, backend: request.backendId });
  assertBridgeCapability(bridge, "review");
  ensureBackendAvailable(request.cwd, bridge);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await bridge.backend.runReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
    });
    const agentResult = {
      status: result.status,
      stderr: result.stderr,
      stdout: result.reviewText,
      reasoning: result.reasoningSummary
    };
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      hostId: bridge.host.id,
      backendId: bridge.backend.id,
      agent: agentResult,
      ...(bridge.backend.id === "codex" ? { codex: agentResult } : {})
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      {
        reviewLabel: reviewName,
        targetLabel: target.label,
        reasoningSummary: result.reasoningSummary,
        backendLabel: bridge.backend.displayName
      }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `${bridge.backend.displayName} ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const reviewContext = (bridge.backend.collectReviewContext ?? collectReviewContext)(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(reviewContext, focusText);
  const result = await bridge.backend.runTask(reviewContext.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: bridge.backend.readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = bridge.backend.parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  if (result.status !== 0) {
    parsed.parsed = null;
    parsed.parseError = result.error?.message || result.stderr || "The review did not complete successfully.";
  }
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: reviewContext.repoRoot,
      branch: reviewContext.branch,
      summary: reviewContext.summary
    },
    hostId: bridge.host.id,
    backendId: bridge.backend.id,
    agent: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    ...(bridge.backend.id === "codex"
      ? {
          codex: {
            status: result.status,
            stderr: result.stderr,
            stdout: result.finalMessage,
            reasoning: result.reasoningSummary
          }
        }
      : {}),
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: reviewContext.target.label,
      reasoningSummary: result.reasoningSummary,
      backendLabel: bridge.backend.displayName
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `${bridge.backend.displayName} ${reviewName}`,
    jobClass: "review",
    targetLabel: reviewContext.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  const bridge = request.bridgeContext ?? resolveBridgeContext({ host: request.hostId, backend: request.backendId });
  assertBridgeCapability(bridge, "task");
  ensureBackendAvailable(request.cwd, bridge);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast,
    bridge
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, bridge, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error(`No previous ${bridge.backend.displayName} task thread was found for this repository.`);
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await bridge.backend.runTask(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? bridge.backend.defaultContinuePrompt : "",
    model: request.model,
    effort: request.effort,
    sandbox: request.write ? "workspace-write" : "read-only",
    onProgress: request.onProgress,
    persistThread: true,
    threadName: resumeThreadId
      ? null
      : bridge.backend.buildTaskThreadName(request.prompt || bridge.backend.defaultContinuePrompt)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write),
      backendLabel: bridge.backend.displayName
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    hostId: bridge.host.id,
    backendId: bridge.backend.id,
    rawOutput,
    error: result.error?.message ?? null,
    stderr: result.stderr ?? "",
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target, bridge) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? `${bridge.backend.displayName} Review` : `${bridge.backend.displayName} ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false, bridge = resolveBridgeContext() }) {
  if (
    !resumeLast &&
    bridge.host.stopReviewTaskMarker &&
    String(prompt ?? "").includes(bridge.host.stopReviewTaskMarker)
  ) {
    return {
      title: `${bridge.backend.displayName} Stop Gate Review`,
      summary: `Stop-gate review of previous ${bridge.host.displayName} turn`
    };
  }

  const title = resumeLast ? `${bridge.backend.displayName} Resume` : `${bridge.backend.displayName} Task`;
  const fallbackSummary = resumeLast ? bridge.backend.defaultContinuePrompt : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, bridge, write = false }) {
  return createJobRecord(
    {
      id: generateJobId(prefix),
      kind,
      kindLabel: getJobKindLabel(kind, jobClass),
      title,
      workspaceRoot,
      jobClass,
      summary,
      hostId: bridge.host.id,
      backendId: bridge.backend.id,
      write
    },
    { sessionId: bridge.sessionId }
  );
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, bridge, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    bridge,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId, bridge }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId,
    hostId: bridge.host.id,
    backendId: bridge.backend.id
  };
}

function renderTransferResult(payload, bridge) {
  const lines = [
    `Transferred the ${bridge.host.displayName} session into a ${bridge.backend.displayName} thread with visible turn history.`,
    `${bridge.backend.sessionLabel}: ${payload.threadId}`,
    `Resume in ${bridge.backend.displayName}: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, bridge, options = {}) {
  assertBridgeCapability(bridge, "sessionImport");
  if (!bridge.host.capabilities.sessionExport) {
    throw new Error(`${bridge.host.displayName} does not support session export.`);
  }
  const sessionExport = bridge.host.resolveSessionExport(cwd, {
    source: options.source,
    sessionId: bridge.sessionId
  });
  const result = await bridge.backend.importSession(cwd, {
    sourcePath: sessionExport.sourcePath,
    sourceFormat: sessionExport.format
  });
  const payload = {
    threadId: result.threadId,
    resumeCommand: bridge.backend.formatResumeCommand(result.threadId),
    sourcePath: sessionExport.sourcePath,
    sessionId: sessionExport.sourceSessionId ?? path.basename(sessionExport.sourcePath, ".jsonl"),
    hostId: bridge.host.id,
    backendId: bridge.backend.id
  };

  return {
    payload,
    rendered: renderTransferResult(payload, bridge)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd", "host", "backend"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const bridge = resolveBridgeContext(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target, bridge);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary,
    bridge
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: bridge.backend.normalizeModel(options.model),
        focusText,
        reviewName: config.reviewName,
        bridgeContext: bridge,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "host", "backend"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const bridge = resolveBridgeContext(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = bridge.backend.normalizeModel(options.model);
  const effort = bridge.backend.normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast,
    bridge
  });

  if (options.background) {
    assertBridgeCapability(bridge, "task");
    ensureBackendAvailable(cwd, bridge);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, bridge, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id,
      bridge
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, bridge, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        bridgeContext: bridge,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source", "host", "backend"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const bridge = resolveBridgeContext(options);
  const { payload, rendered } = await executeTransfer(cwd, bridge, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms", "host", "backend"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const bridge = resolveBridgeContext(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, {
    all: options.all,
    hostId: bridge.host.id,
    backendId: bridge.backend.id,
    sessionId: bridge.sessionId,
    sessionRuntime: bridge.backend.getSessionRuntimeStatus(process.env, cwd)
  });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "host", "backend"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const bridge = resolveBridgeContext(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference, {
    hostId: bridge.host.id,
    backendId: bridge.backend.id,
    sessionId: bridge.sessionId
  });
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "host", "backend"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const bridge = resolveBridgeContext(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentHostSessionId(bridge);
  const jobs = filterJobsForBridgeContext(sortJobsNewestFirst(listJobs(workspaceRoot)), bridge);
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "host", "backend"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const bridge = resolveBridgeContext(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, {
    hostId: bridge.host.id,
    backendId: bridge.backend.id,
    sessionId: bridge.sessionId
  });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const jobBackend = resolveBackendForJob(job);
  const interrupt = jobBackend.capabilities.interrupt
    ? await jobBackend.interruptTurn(cwd, { threadId, turnId })
    : { attempted: false, interrupted: false, detail: null };
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested ${jobBackend.displayName} turn interrupt for ${turnId} on ${threadId}.`
        : `${jobBackend.displayName} turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "adapters":
      handleAdapters(argv);
      break;
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
