import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildOpenCodeEnv, installFakeOpenCode } from "./fake-opencode-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const STOP_HOOK = path.join(ROOT, "plugins", "codex", "scripts", "stop-review-gate-hook.mjs");

function createRepo() {
  const repo = makeTempDir("opencode-runtime-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function readFakeState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for OpenCode background state.");
}

test("OpenCode setup reports the selected backend as ready", () => {
  const binDir = makeTempDir();
  installFakeOpenCode(binDir);
  const result = run("node", [SCRIPT, "setup", "--backend", "opencode", "--json"], {
    cwd: ROOT,
    env: buildOpenCodeEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.backend.id, "opencode");
  assert.equal(payload.sessionRuntime.mode, "process");
});

test("OpenCode task maps model, effort, and read-only policy to the CLI", () => {
  const repo = createRepo();
  const binDir = makeTempDir();
  const statePath = installFakeOpenCode(binDir);
  const result = run(
    "node",
    [SCRIPT, "task", "--backend", "opencode", "--model", "anthropic/test", "--effort", "high", "--json", "inspect this repo"],
    { cwd: repo, env: buildOpenCodeEnv(binDir) }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.backendId, "opencode");
  assert.equal(payload.threadId, "ses_1");
  assert.equal(payload.rawOutput, "Handled the OpenCode task.");

  const fakeState = readFakeState(statePath);
  const invocation = fakeState.runs[0];
  assert.equal(invocation.model, "anthropic/test");
  assert.equal(invocation.variant, "high");
  assert.equal(invocation.agent, "agent-bridge-readonly");
  assert.equal(invocation.config.agent[invocation.agent].permission.edit, "deny");
  assert.equal(invocation.args.includes("--auto"), false);
});

test("OpenCode write tasks use the workspace-write policy and report touched files", () => {
  const repo = createRepo();
  const binDir = makeTempDir();
  const statePath = installFakeOpenCode(binDir);
  const result = run("node", [SCRIPT, "task", "--backend", "opencode", "--write", "--json", "update the app"], {
    cwd: repo,
    env: buildOpenCodeEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.touchedFiles, ["src/app.js"]);
  const invocation = readFakeState(statePath).runs[0];
  assert.equal(invocation.agent, "agent-bridge-workspace-write");
  assert.equal(invocation.config.agent[invocation.agent].permission.edit, "allow");
  assert.equal(invocation.config.agent[invocation.agent].permission.external_directory, "deny");
});

test("OpenCode resume reuses the tracked backend session", () => {
  const repo = createRepo();
  const binDir = makeTempDir();
  const statePath = installFakeOpenCode(binDir);
  const env = buildOpenCodeEnv(binDir, { AGENT_BRIDGE_SESSION_ID: "claude-session" });

  const first = run("node", [SCRIPT, "task", "--backend", "opencode", "initial task"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const resumed = run("node", [SCRIPT, "task", "--backend", "opencode", "--resume-last", "follow up"], { cwd: repo, env });

  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /Continued the OpenCode task/);
  assert.equal(readFakeState(statePath).runs[1].resumedSessionId, "ses_1");
});

test("OpenCode review uses the read-only backend path", () => {
  const repo = createRepo();
  const binDir = makeTempDir();
  const statePath = installFakeOpenCode(binDir);
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");

  const result = run("node", [SCRIPT, "review", "--backend", "opencode"], {
    cwd: repo,
    env: buildOpenCodeEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No material issues found/);
  assert.equal(readFakeState(statePath).runs[0].agent, "agent-bridge-readonly");
});

test("OpenCode rejects unsupported cross-agent session transfer", () => {
  const repo = createRepo();
  const binDir = makeTempDir();
  installFakeOpenCode(binDir);
  const result = run("node", [SCRIPT, "transfer", "--backend", "opencode"], {
    cwd: repo,
    env: buildOpenCodeEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not support the sessionImport capability/);
});

test("OpenCode structured failures propagate to task status and stderr", () => {
  const repo = createRepo();
  const binDir = makeTempDir();
  installFakeOpenCode(binDir);
  const result = run("node", [SCRIPT, "task", "--backend", "opencode", "fail the run"], {
    cwd: repo,
    env: buildOpenCodeEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Synthetic OpenCode failure/);
});

test("OpenCode background tasks are visible and cancellable through shared job control", async () => {
  const repo = createRepo();
  const binDir = makeTempDir();
  const pluginData = makeTempDir("opencode-plugin-data-");
  installFakeOpenCode(binDir);
  const env = buildOpenCodeEnv(binDir, {
    AGENT_BRIDGE_SESSION_ID: "background-session",
    CLAUDE_PLUGIN_DATA: pluginData
  });
  const launched = run(
    "node",
    [SCRIPT, "task", "--backend", "opencode", "--background", "--json", "wait until cancelled"],
    { cwd: repo, env }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;

  await waitFor(() => {
    const status = run("node", [SCRIPT, "status", jobId, "--backend", "opencode", "--json"], { cwd: repo, env });
    return status.status === 0 && JSON.parse(status.stdout).job.status === "running";
  });

  const cancelled = run("node", [SCRIPT, "cancel", jobId, "--backend", "opencode", "--json"], { cwd: repo, env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const payload = JSON.parse(cancelled.stdout);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.turnInterruptAttempted, false);

  const status = run("node", [SCRIPT, "status", jobId, "--backend", "opencode", "--json"], { cwd: repo, env });
  assert.equal(JSON.parse(status.stdout).job.status, "cancelled");
});

test("review gate persists and invokes the selected OpenCode backend", () => {
  const repo = createRepo();
  const binDir = makeTempDir();
  const statePath = installFakeOpenCode(binDir);
  const env = buildOpenCodeEnv(binDir);
  const setup = run(
    "node",
    [SCRIPT, "setup", "--backend", "opencode", "--enable-review-gate", "--json"],
    { cwd: repo, env }
  );
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.reviewGateBackendId, "opencode");

  const stopped = run("node", [STOP_HOOK], {
    cwd: repo,
    env,
    input: JSON.stringify({
      cwd: repo,
      session_id: "opencode-stop-session",
      last_assistant_message: "I updated the implementation."
    })
  });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.stdout.trim(), "");
  assert.match(readFakeState(statePath).runs.at(-1).prompt, /Run a stop-gate review/);
});
