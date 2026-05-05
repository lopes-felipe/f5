import {
  type ClaudeCodeEffort,
  type ClaudeModelOptions,
  DEFAULT_REASONING_EFFORT_BY_PROVIDER,
  type CodexModelOptions,
  type CodexReasoningEffort,
  type CursorModelOptions,
  type CursorReasoningOption,
  type OpenCodeModelOptions,
  type ProviderKind,
  type ProviderModelOptions,
  type ProviderOptionSelection,
} from "@t3tools/contracts";

function readRecordField(candidate: Record<string, unknown> | null, key: string) {
  const value = candidate?.[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readCursorReasoning(value: unknown): CursorReasoningOption | undefined {
  return value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "max" ||
    value === "xhigh"
    ? value
    : undefined;
}

export function normalizeProviderModelOptions(
  value: unknown,
  provider?: ProviderKind | null,
  legacy?: {
    effort?: CodexReasoningEffort | null;
    codexFastMode?: boolean | null;
    serviceTier?: string | null;
  },
): ProviderModelOptions | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const codexCandidate = readRecordField(candidate, "codex");
  const claudeCandidate = readRecordField(candidate, "claudeAgent");
  const cursorCandidate = readRecordField(candidate, "cursor");
  const openCodeCandidate = readRecordField(candidate, "opencode");

  const codexReasoningEffort: CodexReasoningEffort | undefined =
    codexCandidate?.reasoningEffort === "low" ||
    codexCandidate?.reasoningEffort === "medium" ||
    codexCandidate?.reasoningEffort === "high" ||
    codexCandidate?.reasoningEffort === "xhigh"
      ? codexCandidate.reasoningEffort
      : provider === "codex" &&
          (legacy?.effort === "low" ||
            legacy?.effort === "medium" ||
            legacy?.effort === "high" ||
            legacy?.effort === "xhigh")
        ? legacy.effort
        : undefined;
  const codexFastMode =
    codexCandidate?.fastMode === true ||
    (provider === "codex" && legacy?.codexFastMode === true) ||
    legacy?.serviceTier === "fast";
  const codex =
    codexReasoningEffort && codexReasoningEffort !== DEFAULT_REASONING_EFFORT_BY_PROVIDER.codex
      ? {
          reasoningEffort: codexReasoningEffort,
          ...(codexFastMode ? { fastMode: true } : {}),
        }
      : codexFastMode
        ? { fastMode: true }
        : undefined;

  const claudeThinking = claudeCandidate?.thinking === false ? false : undefined;
  const claudeEffort: ClaudeCodeEffort | undefined =
    claudeCandidate?.effort === "low" ||
    claudeCandidate?.effort === "medium" ||
    claudeCandidate?.effort === "high" ||
    claudeCandidate?.effort === "xhigh" ||
    claudeCandidate?.effort === "max" ||
    claudeCandidate?.effort === "ultrathink"
      ? claudeCandidate.effort
      : undefined;
  const claudeFastMode = claudeCandidate?.fastMode === true;
  const claudeContextWindow = readTrimmedString(claudeCandidate?.contextWindow);
  const claude =
    claudeThinking === false ||
    claudeEffort !== undefined ||
    claudeFastMode ||
    claudeContextWindow !== undefined
      ? {
          ...(claudeThinking === false ? { thinking: false } : {}),
          ...(claudeEffort ? { effort: claudeEffort } : {}),
          ...(claudeFastMode ? { fastMode: true } : {}),
          ...(claudeContextWindow ? { contextWindow: claudeContextWindow } : {}),
        }
      : undefined;

  const cursorReasoning = readCursorReasoning(cursorCandidate?.reasoning);
  const cursorThinking = readBoolean(cursorCandidate?.thinking);
  const cursorFastMode = readBoolean(cursorCandidate?.fastMode);
  const cursorContextWindow = readTrimmedString(cursorCandidate?.contextWindow);
  const cursor =
    cursorReasoning !== undefined ||
    cursorThinking !== undefined ||
    cursorFastMode !== undefined ||
    cursorContextWindow !== undefined
      ? {
          ...(cursorReasoning ? { reasoning: cursorReasoning } : {}),
          ...(cursorThinking !== undefined ? { thinking: cursorThinking } : {}),
          ...(cursorFastMode !== undefined ? { fastMode: cursorFastMode } : {}),
          ...(cursorContextWindow ? { contextWindow: cursorContextWindow } : {}),
        }
      : undefined;

  const openCodeVariant = readTrimmedString(openCodeCandidate?.variant);
  const openCodeAgent = readTrimmedString(openCodeCandidate?.agent);
  const opencode: OpenCodeModelOptions | undefined =
    openCodeVariant !== undefined || openCodeAgent !== undefined
      ? {
          ...(openCodeVariant ? { variant: openCodeVariant } : {}),
          ...(openCodeAgent ? { agent: openCodeAgent } : {}),
        }
      : undefined;

  if (!codex && !claude && !cursor && !opencode) {
    return null;
  }
  return {
    ...(codex ? { codex } : {}),
    ...(claude ? { claudeAgent: claude } : {}),
    ...(cursor ? { cursor } : {}),
    ...(opencode ? { opencode } : {}),
  };
}

export function providerSelectionsToModelOptions(
  provider: ProviderKind,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ProviderModelOptions | null {
  if (!selections || selections.length === 0) {
    return null;
  }
  const stringValue = (id: string): string | undefined => {
    const value = selections.find((selection) => selection.id === id)?.value;
    return typeof value === "string" ? value : undefined;
  };
  const booleanValue = (id: string): boolean | undefined => {
    const value = selections.find((selection) => selection.id === id)?.value;
    return typeof value === "boolean" ? value : undefined;
  };

  switch (provider) {
    case "codex":
      return normalizeProviderModelOptions({
        codex: {
          ...(stringValue("reasoningEffort")
            ? { reasoningEffort: stringValue("reasoningEffort") }
            : {}),
          ...(booleanValue("fastMode") !== undefined ? { fastMode: booleanValue("fastMode") } : {}),
        },
      });
    case "claudeAgent":
      return normalizeProviderModelOptions({
        claudeAgent: {
          ...(stringValue("effort") ? { effort: stringValue("effort") } : {}),
          ...(booleanValue("thinking") !== undefined ? { thinking: booleanValue("thinking") } : {}),
          ...(booleanValue("fastMode") !== undefined ? { fastMode: booleanValue("fastMode") } : {}),
          ...(stringValue("contextWindow") ? { contextWindow: stringValue("contextWindow") } : {}),
        },
      });
    case "cursor":
      return normalizeProviderModelOptions({
        cursor: {
          ...(stringValue("reasoning") ? { reasoning: stringValue("reasoning") } : {}),
          ...(booleanValue("thinking") !== undefined ? { thinking: booleanValue("thinking") } : {}),
          ...(booleanValue("fastMode") !== undefined ? { fastMode: booleanValue("fastMode") } : {}),
          ...(stringValue("contextWindow") ? { contextWindow: stringValue("contextWindow") } : {}),
        },
      });
    case "opencode":
      return normalizeProviderModelOptions({
        opencode: {
          ...(stringValue("variant") ? { variant: stringValue("variant") } : {}),
          ...(stringValue("agent") ? { agent: stringValue("agent") } : {}),
        },
      });
  }
}

export function providerModelOptionsToSelections(
  provider: ProviderKind,
  modelOptions: ProviderModelOptions | null | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  const normalized = normalizeProviderModelOptions(modelOptions);
  const providerOptions = normalized?.[provider];
  if (!providerOptions) {
    return undefined;
  }

  const selections: ProviderOptionSelection[] = [];
  const pushString = (id: string, value: unknown) => {
    const normalizedValue = readTrimmedString(value);
    if (normalizedValue) {
      selections.push({ id, value: normalizedValue });
    }
  };
  const pushBoolean = (id: string, value: unknown) => {
    if (typeof value === "boolean") {
      selections.push({ id, value });
    }
  };

  switch (provider) {
    case "codex": {
      const codexOptions = providerOptions as CodexModelOptions;
      pushString("reasoningEffort", codexOptions.reasoningEffort);
      pushBoolean("fastMode", codexOptions.fastMode);
      break;
    }
    case "claudeAgent": {
      const claudeOptions = providerOptions as ClaudeModelOptions;
      pushString("effort", claudeOptions.effort);
      pushBoolean("thinking", claudeOptions.thinking);
      pushBoolean("fastMode", claudeOptions.fastMode);
      pushString("contextWindow", claudeOptions.contextWindow);
      break;
    }
    case "cursor": {
      const cursorOptions = providerOptions as CursorModelOptions;
      pushString("reasoning", cursorOptions.reasoning);
      pushBoolean("thinking", cursorOptions.thinking);
      pushBoolean("fastMode", cursorOptions.fastMode);
      pushString("contextWindow", cursorOptions.contextWindow);
      break;
    }
    case "opencode": {
      const openCodeOptions = providerOptions as OpenCodeModelOptions;
      pushString("variant", openCodeOptions.variant);
      pushString("agent", openCodeOptions.agent);
      break;
    }
  }

  return selections.length > 0 ? selections : undefined;
}
