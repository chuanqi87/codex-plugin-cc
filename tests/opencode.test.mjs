import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenCodeTaskThreadName
} from "../plugins/codex/scripts/lib/opencode.mjs";
import { createOpenCodeEventCollector } from "../plugins/codex/scripts/lib/opencode-events.mjs";
import { buildOpenCodeEnvironment } from "../plugins/codex/scripts/lib/opencode-policy.mjs";

test("OpenCode read-only policy denies edits, delegated tasks, and shell commands", () => {
  const { agentName, env } = buildOpenCodeEnvironment("read-only", {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "test/model", agent: { existing: { mode: "subagent" } } })
  });
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);

  assert.equal(agentName, "agent-bridge-readonly");
  assert.equal(config.model, "test/model");
  assert.equal(config.agent.existing.mode, "subagent");
  assert.equal(config.agent[agentName].permission.edit, "deny");
  assert.equal(config.agent[agentName].permission.task, "deny");
  assert.equal(config.agent[agentName].permission.bash, "deny");
});

test("OpenCode workspace-write policy allows edits but keeps external directories denied", () => {
  const { agentName, env } = buildOpenCodeEnvironment("workspace-write", {});
  const permission = JSON.parse(env.OPENCODE_CONFIG_CONTENT).agent[agentName].permission;

  assert.equal(agentName, "agent-bridge-workspace-write");
  assert.equal(permission.edit, "allow");
  assert.equal(permission.external_directory, "deny");
});

test("OpenCode policy rejects malformed inline configuration", () => {
  assert.throws(
    () => buildOpenCodeEnvironment("read-only", { OPENCODE_CONFIG_CONTENT: "not-json" }),
    /Invalid OPENCODE_CONFIG_CONTENT/
  );
});

test("OpenCode JSON events are normalized into the common task result", () => {
  const progress = [];
  const collector = createOpenCodeEventCollector({ onProgress: (event) => progress.push(event) });
  collector.consume({ type: "session.created", properties: { info: { id: "ses_123" } } });
  collector.consume({
    type: "message.updated",
    properties: { info: { id: "msg_1", role: "assistant", sessionID: "ses_123" } }
  });
  collector.consume({
    type: "message.part.updated",
    properties: { part: { id: "reason_1", messageID: "msg_1", sessionID: "ses_123", type: "reasoning", text: "Inspecting files" } }
  });
  collector.consume({
    type: "message.part.updated",
    properties: { part: { id: "text_1", messageID: "msg_1", sessionID: "ses_123", type: "text", text: "Done." } }
  });
  collector.consume({ type: "file.edited", properties: { file: "src/app.js" } });

  assert.deepEqual(collector.result(), {
    threadId: "ses_123",
    finalMessage: "Done.",
    reasoningSummary: ["Inspecting files"],
    touchedFiles: ["src/app.js"],
    errorMessage: null,
    invalidLines: []
  });
  assert.ok(progress.some((event) => event.phase === "reasoning"));
  assert.ok(progress.some((event) => event.phase === "editing"));
});

test("OpenCode CLI JSON events are normalized into the common task result", () => {
  const collector = createOpenCodeEventCollector();
  collector.consume({
    type: "step_start",
    sessionID: "ses_cli",
    part: { id: "step_1", messageID: "msg_cli", sessionID: "ses_cli", type: "step-start" }
  });
  collector.consume({
    type: "reasoning",
    sessionID: "ses_cli",
    part: { id: "reason_1", messageID: "msg_cli", sessionID: "ses_cli", type: "reasoning", text: "Inspecting files" }
  });
  collector.consume({
    type: "text",
    sessionID: "ses_cli",
    part: { id: "text_1", messageID: "msg_cli", sessionID: "ses_cli", type: "text", text: "Done." }
  });
  collector.consume({
    type: "step_finish",
    sessionID: "ses_cli",
    part: { id: "step_2", messageID: "msg_cli", sessionID: "ses_cli", type: "step-finish" }
  });

  assert.deepEqual(collector.result(), {
    threadId: "ses_cli",
    finalMessage: "Done.",
    reasoningSummary: ["Inspecting files"],
    touchedFiles: [],
    errorMessage: null,
    invalidLines: []
  });
});

test("OpenCode CLI top-level errors preserve their actionable message", () => {
  const collector = createOpenCodeEventCollector();
  collector.consume({
    type: "error",
    sessionID: "ses_failed",
    error: { name: "UnknownError", data: { message: "Unexpected server error. Check server logs for details." } }
  });

  assert.equal(collector.result().threadId, "ses_failed");
  assert.equal(collector.result().errorMessage, "Unexpected server error. Check server logs for details.");
});

test("OpenCode task names use the backend-neutral bridge prefix", () => {
  assert.equal(buildOpenCodeTaskThreadName("inspect the parser"), "Agent Bridge Task: inspect the parser");
});
