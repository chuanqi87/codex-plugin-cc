import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export function installFakeOpenCode(binDir) {
  const statePath = path.join(binDir, "fake-opencode-state.json");
  const scriptPath = path.join(binDir, process.platform === "win32" ? "opencode.cmd" : "opencode");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");

const STATE_PATH = ${JSON.stringify(statePath)};
const args = process.argv.slice(2);

function loadState() {
  return fs.existsSync(STATE_PATH)
    ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8"))
    : { nextSessionId: 1, sessions: [], runs: [] };
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function send(event) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}

if (args.includes("--version")) {
  process.stdout.write("1.18.27\\n");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "list") {
  process.stdout.write("Credentials configured\\n");
  process.exit(0);
}

if (args[0] === "session" && args[1] === "list") {
  process.stdout.write(JSON.stringify(loadState().sessions));
  process.exit(0);
}

if (args[0] !== "run") {
  process.stderr.write("Unsupported fake OpenCode command: " + args.join(" ") + "\\n");
  process.exit(2);
}

const state = loadState();
const resumedSessionId = option("--session");
const sessionId = resumedSessionId || "ses_" + state.nextSessionId++;
const directory = option("--dir") || process.cwd();
const title = option("--title") || "Untitled";
const prompt = fs.readFileSync(0, "utf8");
const scenario = process.env.FAKE_OPENCODE_SCENARIO;
const run = {
  args,
  agent: option("--agent"),
  config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}"),
  directory,
  model: option("--model"),
  prompt,
  resumedSessionId,
  sessionId,
  variant: option("--variant")
};
state.runs.push(run);
if (!resumedSessionId) {
  state.sessions.unshift({ id: sessionId, title, directory, time: { updated: Date.now() } });
}
saveState(state);

if (scenario === "empty") process.exit(0);
if (scenario === "malformed") {
  process.stdout.write("OpenCode protocol was not available\\n");
  process.exit(0);
}
const messageId = "msg_" + state.runs.length;
function part(type, value, messageID = messageId) {
  send({ type: type.replaceAll("-", "_"), sessionID: sessionId, part: { id: type + "_" + messageID, messageID, sessionID: sessionId, type, ...value } });
}
part("step-start", {});
if (scenario === "zero-exit-error") {
  send({ type: "error", sessionID: sessionId, error: { data: { message: "Provider rejected the request." } } });
  process.exit(0);
}
if (prompt.includes("fail the run")) {
  send({ type: "error", sessionID: sessionId, error: { data: { message: "Synthetic OpenCode failure." } } });
  process.exit(1);
}
if (args.includes("--thinking")) part("reasoning", { text: "Inspected the requested scope.", time: { end: Date.now() } });

function finish() {
  if (option("--agent") === "agent-bridge-workspace-write") {
    part("tool", { tool: "write", state: { status: "completed", input: { filePath: "src/app.js" }, metadata: {} } });
  }
  if (scenario === "multi-step") {
    part("text", { text: "I will inspect the code first." }, "msg_intermediate");
    part("step-finish", { reason: "tool-calls" }, "msg_intermediate");
    part("step-start", {});
  }
  const response = prompt.includes("Return only valid JSON matching this JSON Schema:") && scenario !== "invalid-structured"
    ? JSON.stringify({ verdict: "approve", summary: "No material issues found.", findings: [], next_steps: [] })
    : prompt.includes("Run a stop-gate review")
    ? "ALLOW: no blocking issue found."
    : (prompt.includes("Review the current")
        ? "Reviewed the requested changes. No material issues found."
        : (resumedSessionId ? "Continued the OpenCode task." : "Handled the OpenCode task."));
  const finalMessageId = scenario === "multi-step" ? "msg_final" : messageId;
  part("text", { text: response, time: { end: Date.now() } }, finalMessageId);
  if (scenario !== "partial") part("step-finish", { reason: scenario === "truncated" ? "length" : "stop" }, finalMessageId);
}

if (prompt.includes("wait until cancelled")) {
  setTimeout(finish, 30000);
} else {
  finish();
}
`;

  writeExecutable(scriptPath, source);
  return statePath;
}

export function buildOpenCodeEnv(binDir, overrides = {}) {
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    CLAUDE_PLUGIN_DATA: overrides.CLAUDE_PLUGIN_DATA ?? path.join(binDir, "plugin-data"),
    ...overrides
  };
}
