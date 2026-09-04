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
const prompt = args[args.length - 1];
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

send({ type: "session.created", properties: { info: { id: sessionId } } });
send({ type: "message.updated", properties: { info: { id: "msg_" + state.runs.length, role: "assistant", sessionID: sessionId } } });
if (prompt.includes("fail the run")) {
  send({ type: "session.error", properties: { error: { data: { message: "Synthetic OpenCode failure." } } } });
  process.exit(1);
}
send({ type: "message.part.updated", properties: { part: { id: "reason_" + state.runs.length, messageID: "msg_" + state.runs.length, sessionID: sessionId, type: "reasoning", text: "Inspected the requested scope." } } });

function finish() {
  if (option("--agent") === "agent-bridge-workspace-write") {
    send({ type: "file.edited", properties: { file: "src/app.js" } });
  }
  const response = prompt.includes("Run a stop-gate review")
    ? "ALLOW: no blocking issue found."
    : (prompt.includes("Review the current")
        ? "Reviewed the requested changes. No material issues found."
        : (resumedSessionId ? "Continued the OpenCode task." : "Handled the OpenCode task."));
  send({ type: "message.part.updated", properties: { part: { id: "text_" + state.runs.length, messageID: "msg_" + state.runs.length, sessionID: sessionId, type: "text", text: response } } });
  send({ type: "session.idle", properties: { sessionID: sessionId } });
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
