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
  if (state.messageRoles.get(part.messageID) === "user") return;
  state.sessionId = part.sessionID ?? state.sessionId;
  if (part.messageID && !state.assistantMessageIds.includes(part.messageID)) {
    state.assistantMessageIds.push(part.messageID);
    state.completed = false;
  }
  if (part.type === "step-start") {
    state.completed = false;
    emitProgress(onProgress, "OpenCode started a response step.", "running", { threadId: state.sessionId });
    return;
  }
  if (part.type === "step-finish") {
    state.completed = part.reason === "stop";
    if (["length", "content-filter", "error"].includes(part.reason)) {
      state.error = `OpenCode response ended with reason "${part.reason}"; the result may be incomplete.`;
    }
    emitProgress(onProgress, `OpenCode response step finished (${part.reason ?? "unknown"}).`, "running", {
      threadId: state.sessionId
    });
    return;
  }
  if (part.type === "text") {
    appendTextPart(state, part, properties.delta);
    emitProgress(onProgress, "OpenCode is composing the final response.", "responding", {
      threadId: state.sessionId
    });
    return;
  }
  if (part.type === "reasoning") {
    appendReasoningPart(state, part, properties.delta);
    emitProgress(onProgress, "OpenCode is reasoning.", "reasoning", {
      threadId: state.sessionId,
      logTitle: "Reasoning summary",
      logBody: part.time?.end ? part.text : null
    });
    return;
  }
  if (part.type === "tool") {
    const toolName = part.tool ?? "tool";
    const toolStatus = part.state?.status ?? "running";
    if (toolStatus === "completed") collectToolFiles(state, part);
    const action = toolStatus === "error" ? "Failed" : toolStatus === "completed" ? "Completed" : "Running";
    emitProgress(onProgress, `${action} ${toolName}.${toolStatus === "error" ? ` ${part.state.error ?? ""}` : ""}`, "investigating", {
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

function collectToolFiles(state, part) {
  if (!["edit", "write", "apply_patch", "multiedit"].includes(part.tool)) return;
  const metadata = part.state.metadata ?? {};
  const files = [part.state.input?.filePath, metadata.filepath];
  for (const file of Array.isArray(metadata.files) ? metadata.files : []) {
    files.push(file.filePath ?? file.relativePath, file.movePath);
  }
  for (const file of files) {
    if (typeof file === "string" && file) state.touchedFiles.add(file);
  }
}

function createCollectorState(threadId) {
  return {
    sessionId: threadId ?? null,
    assistantMessageIds: [],
    messageRoles: new Map(),
    textParts: new Map(),
    textOrder: [],
    reasoningParts: new Map(),
    reasoningOrder: [],
    touchedFiles: new Set(),
    error: null,
    completed: false,
    invalidLines: []
  };
}

function buildCollectorResult(state) {
  const latestMessageId = state.assistantMessageIds.at(-1) ?? null;
  const selectedParts = state.textOrder
    .map((id) => state.textParts.get(id))
    .filter((part) => part && (!latestMessageId || part.messageId === latestMessageId));
  const reasoningSummary = state.reasoningOrder
    .map((id) => state.reasoningParts.get(id)?.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return {
    threadId: state.sessionId,
    finalMessage: selectedParts.map((part) => part.text).join("\n\n").trim(),
    reasoningSummary: [...new Set(reasoningSummary)],
    touchedFiles: [...state.touchedFiles],
    errorMessage: state.error,
    completed: state.completed,
    invalidLines: state.invalidLines
  };
}

export function createOpenCodeEventCollector(options = {}) {
  const state = createCollectorState(options.threadId);

  function consume(event) {
    const properties = event?.properties ?? {};
    if (event?.type === "session.created" && properties.info?.parentID) return;
    const sessionId = event?.part?.sessionID ?? properties.part?.sessionID ??
      properties.info?.sessionID ?? properties.sessionID ?? event?.sessionID ??
      (event?.type === "session.created" ? properties.info?.id : null);
    if (sessionId && state.sessionId && sessionId !== state.sessionId) return;
    state.sessionId ??= sessionId ?? null;
    if (event?.type === "error") {
      state.error = errorMessage(event.error) || "OpenCode session failed.";
      emitProgress(options.onProgress, state.error, "failed", { threadId: state.sessionId });
      return;
    }
    if (event?.part && typeof event.part === "object") {
      collectPartEvent(state, { part: event.part }, options.onProgress);
      return;
    }
    if (event?.type === "session.created") {
      state.sessionId = properties.info?.id ?? state.sessionId;
      emitProgress(options.onProgress, `OpenCode session ready (${state.sessionId}).`, "starting", {
        threadId: state.sessionId
      });
      return;
    }
    if (event?.type === "message.updated") {
      const info = properties.info ?? {};
      if (info.id && info.role) state.messageRoles.set(info.id, info.role);
      state.sessionId = info.sessionID ?? state.sessionId;
      const messageId = info.role === "assistant" ? info.id ?? null : null;
      if (messageId && !state.assistantMessageIds.includes(messageId)) {
        state.assistantMessageIds.push(messageId);
        state.completed = false;
      }
      if (messageId && info.finish === "stop") state.completed = true;
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
    if (event?.type === "session.idle" || (event?.type === "session.status" && properties.status?.type === "idle")) {
      state.completed = true;
    }
  }

  function consumeLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      state.invalidLines.push(trimmed.slice(0, 2048));
      if (state.invalidLines.length > 8) state.invalidLines.shift();
      return;
    }
    consume(event);
  }

  return {
    consume,
    consumeLine,
    result: () => buildCollectorResult(state)
  };
}
