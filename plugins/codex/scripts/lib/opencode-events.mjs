function emitProgress(onProgress, message, phase, extra = {}) {
  onProgress?.({ message, phase, ...extra });
}

function errorMessage(error) {
  if (!error) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  return error.data?.message ?? error.message ?? JSON.stringify(error);
}

function appendTextPart(state, part, delta) {
  const id = part.id ?? `${part.messageID ?? "message"}:${state.textOrder.length}`;
  if (!state.textParts.has(id)) {
    state.textOrder.push(id);
  }
  const previous = state.textParts.get(id) ?? { messageId: part.messageID ?? null, text: "" };
  state.textParts.set(id, {
    messageId: part.messageID ?? previous.messageId,
    text: typeof part.text === "string" ? part.text : `${previous.text}${delta ?? ""}`
  });
}

function appendReasoningPart(state, part, delta) {
  const id = part.id ?? `${part.messageID ?? "message"}:${state.reasoningOrder.length}`;
  if (!state.reasoningParts.has(id)) {
    state.reasoningOrder.push(id);
  }
  const previous = state.reasoningParts.get(id) ?? "";
  state.reasoningParts.set(id, typeof part.text === "string" ? part.text : `${previous}${delta ?? ""}`);
}

function collectPartEvent(state, properties, onProgress) {
  const part = properties.part ?? {};
  state.sessionId = part.sessionID ?? state.sessionId;
  if (part.type === "text") {
    appendTextPart(state, part, properties.delta);
    emitProgress(onProgress, "OpenCode is composing the final response.", "responding", {
      threadId: state.sessionId
    });
    return;
  }
  if (part.type === "reasoning") {
    appendReasoningPart(state, part, properties.delta);
    emitProgress(onProgress, "OpenCode is reasoning.", "reasoning", { threadId: state.sessionId });
    return;
  }
  if (part.type === "tool") {
    const toolName = part.tool ?? "tool";
    const toolStatus = part.state?.status ?? "running";
    emitProgress(onProgress, `${toolStatus === "completed" ? "Completed" : "Running"} ${toolName}.`, "tool", {
      threadId: state.sessionId
    });
    return;
  }
  if (part.type === "patch") {
    for (const file of part.files ?? []) {
      state.touchedFiles.add(file);
    }
    emitProgress(onProgress, "OpenCode updated workspace files.", "editing", { threadId: state.sessionId });
  }
}

function createCollectorState() {
  return {
    sessionId: null,
    assistantMessageIds: [],
    textParts: new Map(),
    textOrder: [],
    reasoningParts: new Map(),
    reasoningOrder: [],
    touchedFiles: new Set(),
    error: null,
    invalidLines: []
  };
}

function buildCollectorResult(state) {
  const latestMessageId = state.assistantMessageIds.at(-1) ?? null;
  const selectedParts = state.textOrder
    .map((id) => state.textParts.get(id))
    .filter((part) => part && (!latestMessageId || part.messageId === latestMessageId));
  const fallbackParts = state.textOrder.map((id) => state.textParts.get(id)).filter(Boolean);
  const finalParts = selectedParts.length > 0 ? selectedParts : fallbackParts;
  const reasoningSummary = state.reasoningOrder
    .map((id) => state.reasoningParts.get(id)?.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return {
    threadId: state.sessionId,
    finalMessage: finalParts.map((part) => part.text).join("").trim(),
    reasoningSummary: [...new Set(reasoningSummary)],
    touchedFiles: [...state.touchedFiles],
    errorMessage: state.error,
    invalidLines: state.invalidLines
  };
}

export function createOpenCodeEventCollector(options = {}) {
  const state = createCollectorState();

  function consume(event) {
    const properties = event?.properties ?? {};
    if (event?.type === "session.created") {
      state.sessionId = properties.info?.id ?? state.sessionId;
      emitProgress(options.onProgress, `OpenCode session ready (${state.sessionId}).`, "starting", {
        threadId: state.sessionId
      });
      return;
    }
    if (event?.type === "message.updated") {
      const info = properties.info ?? {};
      state.sessionId = info.sessionID ?? state.sessionId;
      const messageId = info.role === "assistant" ? info.id ?? null : null;
      if (messageId && !state.assistantMessageIds.includes(messageId)) {
        state.assistantMessageIds.push(messageId);
      }
      if (info.error) {
        state.error = errorMessage(info.error);
      }
      return;
    }
    if (event?.type === "message.part.updated") {
      collectPartEvent(state, properties, options.onProgress);
      return;
    }
    if (event?.type === "file.edited") {
      if (properties.file) {
        state.touchedFiles.add(properties.file);
      }
      emitProgress(options.onProgress, "OpenCode updated a workspace file.", "editing", {
        threadId: state.sessionId
      });
      return;
    }
    if (event?.type === "session.diff") {
      for (const change of properties.diff ?? []) {
        if (change.file) {
          state.touchedFiles.add(change.file);
        }
      }
      return;
    }
    if (event?.type === "session.error") {
      state.error = errorMessage(properties.error) || "OpenCode session failed.";
      emitProgress(options.onProgress, state.error, "failed", { threadId: state.sessionId });
      return;
    }
    if (event?.type === "session.idle") {
      emitProgress(options.onProgress, "OpenCode session completed.", "completed", {
        threadId: state.sessionId
      });
    }
  }

  function consumeLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      consume(JSON.parse(trimmed));
    } catch {
      state.invalidLines.push(trimmed);
    }
  }

  return {
    consume,
    consumeLine,
    result: () => buildCollectorResult(state)
  };
}
