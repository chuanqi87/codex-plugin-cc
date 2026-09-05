import process from "node:process";

const READ_ONLY_AGENT = "agent-bridge-readonly";
const WRITE_AGENT = "agent-bridge-workspace-write";

function parseInlineConfig(rawConfig) {
  if (!rawConfig?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(rawConfig);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the value must be a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid OPENCODE_CONFIG_CONTENT: ${error.message}`);
  }
}

function buildPermissionPolicy(readOnly) {
  if (readOnly) {
    return {
      "*": "deny",
      read: { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
      glob: "allow",
      grep: "allow",
      list: "allow",
      webfetch: "allow",
      websearch: "allow",
      lsp: "allow",
      skill: "allow",
      todoread: "allow",
      todowrite: "allow",
      edit: "deny",
      task: "deny",
      external_directory: "deny",
      bash: "deny"
    };
  }
  return {
    edit: "allow",
    bash: "allow",
    task: "deny",
    external_directory: "deny",
    question: "deny",
    plan_enter: "deny",
    plan_exit: "deny"
  };
}

export function buildOpenCodeEnvironment(sandbox, env = process.env) {
  const config = parseInlineConfig(env.OPENCODE_CONFIG_CONTENT);
  const readOnly = sandbox !== "workspace-write";
  const agentName = readOnly ? READ_ONLY_AGENT : WRITE_AGENT;
  const bridgeAgent = {
    description: readOnly
      ? "Agent Bridge read-only analysis agent"
      : "Agent Bridge workspace-scoped implementation agent",
    mode: "primary",
    permission: buildPermissionPolicy(readOnly)
  };

  return {
    agentName,
    env: {
      ...env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...config,
        agent: {
          ...(config.agent ?? {}),
          [agentName]: bridgeAgent
        }
      })
    }
  };
}
