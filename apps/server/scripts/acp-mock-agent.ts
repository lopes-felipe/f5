#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import * as Effect from "effect/Effect";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as EffectAcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

const requestLogPath = process.env.T3_ACP_REQUEST_LOG_PATH;
const exitLogPath = process.env.T3_ACP_EXIT_LOG_PATH;
const emitToolCalls = process.env.T3_ACP_EMIT_TOOL_CALLS === "1";
const emitInterleavedAssistantToolCalls =
  process.env.T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS === "1";
const emitBackgroundToolDuringAnswer =
  process.env.T3_ACP_EMIT_BACKGROUND_TOOL_DURING_ANSWER === "1";
const emitToolSpanningTurns = process.env.T3_ACP_EMIT_TOOL_SPANNING_TURNS === "1";
let spanningPromptCount = 0;
const emitExtensionsAcrossTurns = process.env.T3_ACP_EMIT_EXTENSIONS_ACROSS_TURNS === "1";
let extensionsPromptCount = 0;
const emitGenericToolPlaceholders = process.env.T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS === "1";
const emitAskQuestion = process.env.T3_ACP_EMIT_ASK_QUESTION === "1";
const emitQuestionFallback = process.env.T3_ACP_EMIT_QUESTION_FALLBACK === "1";
const emitCursorExtensionRequests = process.env.T3_ACP_EMIT_CURSOR_EXTENSION_REQUESTS === "1";
const secondModelOption = process.env.T3_ACP_SECOND_MODEL_OPTION === "1";
const failSetConfigOption = process.env.T3_ACP_FAIL_SET_CONFIG_OPTION === "1";
const exitOnSetConfigOption = process.env.T3_ACP_EXIT_ON_SET_CONFIG_OPTION === "1";
const exitDuringPrompt = process.env.T3_ACP_EXIT_DURING_PROMPT === "1";
const promptResponseText = process.env.T3_ACP_PROMPT_RESPONSE_TEXT;
const promptDelayMs = Math.max(
  0,
  Number.parseInt(process.env.T3_ACP_PROMPT_DELAY_MS ?? "0", 10) || 0,
);
const loadDelayMs = Math.max(0, Number.parseInt(process.env.T3_ACP_LOAD_DELAY_MS ?? "0", 10) || 0);
const loadResponseDelayMs = Math.max(
  0,
  Number.parseInt(process.env.T3_ACP_LOAD_RESPONSE_DELAY_MS ?? "0", 10) || 0,
);
const failLoadNotFound = process.env.T3_ACP_LOAD_FAIL_NOT_FOUND === "1";
const failLoadAfterReplay = process.env.T3_ACP_LOAD_FAIL_AFTER_REPLAY === "1";
const hangLoad = process.env.T3_ACP_LOAD_HANG === "1";
const replayBeforeLoadHang = process.env.T3_ACP_LOAD_REPLAY_BEFORE_HANG === "1";
const omitAllowAlways = process.env.T3_ACP_OMIT_ALLOW_ALWAYS === "1";
const permissionRequestCount = Math.max(
  1,
  Number.parseInt(process.env.T3_ACP_PERMISSION_REQUEST_COUNT ?? "1", 10) || 1,
);
const sessionId = "mock-session-1";

/**
 * Antigravity profile: Gemini models with per-model `thought_level` options,
 * native session modes (`default`, `plan`, and `auto` when advertised), usage
 * frames and post-prompt wakes. Shapes follow the R0 capture allowlist.
 */
const antigravityProfile = process.env.F5_ACP_ANTIGRAVITY_PROFILE === "1";
const antigravityAuto = process.env.F5_ACP_ANTIGRAVITY_AUTO === "1";
const antigravityModeConfig = process.env.F5_ACP_ANTIGRAVITY_MODE_CONFIG === "1";
const antigravityNoPlan = process.env.F5_ACP_ANTIGRAVITY_NO_PLAN === "1";
const emitUsageFrames = process.env.F5_ACP_USAGE_FRAMES === "1";
const postPromptWakeMs = Math.max(
  0,
  Number.parseInt(process.env.F5_ACP_POST_PROMPT_WAKE_MS ?? "0", 10) || 0,
);
const ANTIGRAVITY_MODELS: ReadonlyArray<{
  readonly value: string;
  readonly name: string;
  readonly levels: ReadonlyArray<string>;
  readonly defaultLevel?: string;
}> = [
  { value: "gemini-4-orchestrator", name: "Gemini 4 Orchestrator", levels: [] },
  {
    value: "gemini-4-neon",
    name: "Gemini 4 Neon",
    // Google lists four Neon thinking levels.
    levels: ["low", "medium", "high", "xhigh"],
    defaultLevel: "high",
  },
  {
    value: "gemini-4-carbon",
    name: "Gemini 4 Carbon",
    levels: ["low", "high"],
    defaultLevel: "low",
  },
  {
    value: "gemini-4-hydrogen",
    name: "Gemini 4 Hydrogen",
    levels: ["minimal", "low", "medium"],
    defaultLevel: "low",
  },
];
let antigravityModelId = process.env.F5_ACP_ANTIGRAVITY_DEFAULT_MODEL ?? "gemini-4-carbon";
const antigravityLevelFor = (model: string) =>
  ANTIGRAVITY_MODELS.find((entry) => entry.value === model)?.defaultLevel;
let antigravityLevel = antigravityLevelFor(antigravityModelId);
const antigravityModes = (): ReadonlyArray<AcpSchema.SessionMode> => [
  { id: "default", name: "Default", description: "Ask before acting" },
  ...(antigravityNoPlan ? [] : [{ id: "plan", name: "Plan", description: "Plan only" }]),
  ...(antigravityAuto ? [{ id: "auto", name: "Auto", description: "Native review" }] : []),
];
let antigravityModeId = "default";
let usageUsed = 0;

function antigravityConfigOptions(): ReadonlyArray<AcpSchema.SessionConfigOption> {
  const model = ANTIGRAVITY_MODELS.find((entry) => entry.value === antigravityModelId);
  return [
    ...(antigravityModeConfig
      ? [
          {
            id: "mode",
            name: "Mode",
            category: "mode",
            type: "select" as const,
            currentValue: antigravityModeId,
            options: antigravityModes().map((mode) => ({ value: mode.id, name: mode.name })),
          },
        ]
      : []),
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue: antigravityModelId,
      options: ANTIGRAVITY_MODELS.map((entry) => ({ value: entry.value, name: entry.name })),
    },
    ...(model && model.levels.length > 0 && antigravityLevel
      ? [
          {
            id: "thought_level",
            name: "Thinking",
            category: "thought_level",
            type: "select" as const,
            currentValue: antigravityLevel,
            options: model.levels.map((level) => ({ value: level, name: level })),
          },
        ]
      : []),
  ];
}

const urlModes = process.env.T3_ACP_URL_MODES === "1";
const modeId = (id: string) =>
  urlModes ? "https://agentclientprotocol.com/protocol/session-modes#" + id : id;
let currentModeId = modeId(process.env.T3_ACP_INITIAL_MODE ?? "ask");
const modePath = process.env.T3_ACP_MODE_PATH;
if (modePath && existsSync(modePath)) currentModeId = readFileSync(modePath, "utf8");
const saveMode = () => {
  if (modePath) writeFileSync(modePath, currentModeId);
};
let currentModelId = "default";
let parameterizedModelPicker = true;
let currentReasoning = "medium";
let currentContext = "272k";
let currentFast = false;
const cancelledSessions = new Set<string>();

function logExit(reason: string): void {
  if (!exitLogPath) {
    return;
  }
  appendFileSync(exitLogPath, `${reason}\n`, "utf8");
}

process.once("SIGTERM", () => {
  logExit("SIGTERM");
  process.exit(0);
});

process.once("SIGINT", () => {
  logExit("SIGINT");
  process.exit(0);
});

process.once("exit", (code) => {
  logExit(`exit:${code}`);
});

function primaryConfigOptions(): ReadonlyArray<AcpSchema.SessionConfigOption> {
  if (parameterizedModelPicker) {
    const baseOptions: Array<AcpSchema.SessionConfigOption> = [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: currentModeId,
        options: availableModes.map((mode) => ({
          value: mode.id,
          name: mode.name,
          ...(mode.description ? { description: mode.description } : {}),
        })),
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: currentModelId,
        options: [
          { value: "default", name: "Auto" },
          { value: "composer-2", name: "Composer 2" },
          { value: "gpt-5.4", name: "GPT-5.4" },
          { value: "claude-opus-4-6", name: "Opus 4.6" },
        ],
      },
    ];

    switch (currentModelId) {
      case "gpt-5.4":
        return [
          ...baseOptions,
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: currentReasoning,
            options: [
              { value: "none", name: "None" },
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
              { value: "extra-high", name: "Extra High" },
            ],
          },
          {
            id: "context",
            name: "Context",
            category: "model_config",
            type: "select",
            currentValue: currentContext,
            options: [
              { value: "272k", name: "272K" },
              { value: "1m", name: "1M" },
            ],
          },
          {
            id: "fast",
            name: "Fast",
            category: "model_config",
            type: "select",
            currentValue: String(currentFast),
            options: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        ];
      case "composer-2":
        return [
          ...baseOptions,
          {
            id: "fast",
            name: "Fast",
            category: "model_config",
            type: "select",
            currentValue: String(currentFast),
            options: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        ];
      case "claude-opus-4-6":
        return [
          ...baseOptions,
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: currentReasoning,
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
          {
            id: "thinking",
            name: "Thinking",
            category: "model_config",
            type: "boolean",
            currentValue: true,
          },
        ];
      default:
        return baseOptions;
    }
  }

  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue: currentModelId,
      options: [
        { value: "default", name: "Auto" },
        { value: "composer-2", name: "Composer 2" },
        { value: "composer-2[fast=true]", name: "Composer 2 Fast" },
        { value: "gpt-5.3-codex[reasoning=medium,fast=false]", name: "Codex 5.3" },
      ],
    },
  ];
}

function configOptions(): ReadonlyArray<AcpSchema.SessionConfigOption> {
  if (antigravityProfile) return antigravityConfigOptions();
  const options = primaryConfigOptions().filter(
    (option) => !urlModes || option.category !== "mode",
  );
  return secondModelOption
    ? [
        ...options,
        {
          id: "subagent_model",
          name: "Subagent model",
          category: "model",
          type: "select",
          currentValue: "default",
          options: [{ value: "default", name: "Auto" }],
        },
      ]
    : options;
}

const availableModes: ReadonlyArray<AcpSchema.SessionMode> = [
  {
    id: modeId("ask"),
    name: "Ask",
    description: "Request permission before making any changes",
  },
  {
    id: modeId("architect"),
    name: "Architect",
    description: "Design and plan software systems without implementation",
  },
  {
    id: modeId("code"),
    name: "Code",
    description: "Write and modify code with full tool access",
  },
];

function modeState(): AcpSchema.SessionModeState | undefined {
  if (antigravityProfile)
    return antigravityModeConfig
      ? undefined
      : { currentModeId: antigravityModeId, availableModes: antigravityModes() };
  return {
    currentModeId,
    availableModes,
  };
}

function withModes(): { modes?: AcpSchema.SessionModeState } {
  const modes = modeState();
  return modes ? { modes } : {};
}

const program = Effect.gen(function* () {
  const agent = yield* EffectAcpAgent.AcpAgent;

  yield* agent.handleInitialize((request) =>
    Effect.gen(function* () {
      if (process.env.ACP_MOCK_ID_ONLY_PERMISSION === "1") {
        yield* agent.client.requestPermission({
          sessionId,
          toolCall: { toolCallId: "before-start" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        });
      }
      parameterizedModelPicker =
        request.clientCapabilities?._meta?.parameterizedModelPicker !== false;
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          ...(process.env.ACP_MOCK_MCP_HTTP === "1" ? { mcpCapabilities: { http: true } } : {}),
        },
      };
    }),
  );

  yield* agent.handleAuthenticate(() =>
    process.env.ACP_MOCK_AUTH_FAIL === "1"
      ? Effect.fail(AcpError.AcpRequestError.internalError("Mock authentication failed"))
      : Effect.succeed({}),
  );

  yield* agent.handleCreateSession(() =>
    Effect.gen(function* () {
      if (process.env.ACP_MOCK_NEW_HANG === "1") return yield* Effect.never;
      if (process.env.ACP_MOCK_NEW_FAIL === "1")
        return yield* AcpError.AcpRequestError.internalError("Mock session failed");
      if (process.env.F5_ACP_STARTUP_NOTICES === "1") {
        for (const id of ["unrelated-session", sessionId]) {
          yield* agent.raw.notify("session/update", {
            sessionId: id,
            update: {
              sessionUpdate: "notice",
              severity: "warning",
              title: id === sessionId ? "Skipped skill" : "Unrelated notice",
              description: "Startup details",
            },
          });
        }
      }
      if (process.env.F5_ACP_STARTUP_COMMANDS === "1") {
        yield* agent.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "review", description: "Review changes" },
              { name: "compact", description: "Compact session" },
            ],
          },
        });
      }
      // A context sample before session/new returns; the client must keep the latest one.
      if (process.env.F5_ACP_STARTUP_USAGE === "1") {
        for (const used of [300, 500])
          yield* agent.raw.notify("session/update", {
            sessionId,
            update: { sessionUpdate: "usage_update", used, size: 1_048_576 },
          });
      }
      return { sessionId, ...withModes(), configOptions: configOptions() };
    }),
  );

  yield* agent.handleResumeSession(() =>
    Effect.gen(function* () {
      if (process.env.T3_ACP_RESUME_FAIL === "missing")
        return yield* AcpError.AcpRequestError.resourceNotFound("Mock session not found");
      if (process.env.T3_ACP_RESUME_FAIL === "transient")
        return yield* AcpError.AcpRequestError.internalError("Mock temporary failure");
      return { ...withModes(), configOptions: configOptions() };
    }),
  );

  yield* agent.handleLoadSession((request) =>
    Effect.gen(function* () {
      if (loadDelayMs > 0) {
        yield* Effect.sleep(`${loadDelayMs} millis`);
      }
      if (failLoadNotFound) {
        return yield* AcpError.AcpRequestError.resourceNotFound("Mock session not found");
      }

      if (!hangLoad || replayBeforeLoadHang) {
        yield* agent.client.sessionUpdate({
          sessionId: String(request.sessionId ?? sessionId),
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "replay" },
          },
        });
      }
      if (failLoadAfterReplay) {
        return yield* AcpError.AcpRequestError.internalError("Mock late load failure");
      }
      if (hangLoad) {
        return yield* Effect.never;
      }
      if (loadResponseDelayMs > 0) {
        yield* Effect.sleep(`${loadResponseDelayMs} millis`);
      }
      return {
        ...withModes(),
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleSetSessionConfigOption((request) =>
    Effect.gen(function* () {
      if (exitOnSetConfigOption) {
        return yield* Effect.sync(() => {
          process.exit(7);
        });
      }
      if (failSetConfigOption) {
        return yield* AcpError.AcpRequestError.invalidParams(
          "Mock invalid params for session/set_config_option",
          {
            method: "session/set_config_option",
            params: request,
          },
        );
      }
      if (antigravityProfile && typeof request.value === "string") {
        if (request.configId === "model") {
          if (!ANTIGRAVITY_MODELS.some((entry) => entry.value === request.value))
            return yield* AcpError.AcpRequestError.invalidParams("Unknown model");
          antigravityModelId = request.value;
          antigravityLevel = antigravityLevelFor(antigravityModelId);
        } else if (request.configId === "thought_level") {
          antigravityLevel = request.value;
        } else if (request.configId === "mode") {
          if (!antigravityModes().some((mode) => mode.id === request.value))
            return yield* AcpError.AcpRequestError.invalidParams("Unknown mode");
          antigravityModeId = request.value;
        }
        return { configOptions: configOptions() };
      }
      if (request.configId === "mode" && typeof request.value === "string") {
        currentModeId = request.value;
        saveMode();
      }
      if (request.configId === "model" && typeof request.value === "string") {
        currentModelId = request.value;
      }
      if (request.configId === "reasoning" && typeof request.value === "string") {
        currentReasoning = request.value;
      }
      if (request.configId === "context" && typeof request.value === "string") {
        currentContext = request.value;
      }
      if (request.configId === "fast") {
        currentFast = request.value === true || request.value === "true";
      }
      return {
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleSetSessionModel((request) =>
    Effect.sync(() => {
      currentModelId = request.modelId;
      return {};
    }),
  );

  yield* agent.handleCancel(({ sessionId }) =>
    Effect.sync(() => {
      cancelledSessions.add(String(sessionId ?? "mock-session-1"));
    }),
  );

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);
      if (
        request.prompt.some(
          (block) => block.type === "text" && block.text === "silent-inactivity-test",
        )
      ) {
        return yield* Effect.never;
      }
      // Echo a value (a configured secret, say) in assistant text and a tool update.
      const echo = process.env.F5_ACP_ECHO_TEXT;
      if (echo) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `echo ${echo}` },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "echo-tool",
            title: "Read environment",
            kind: "read",
            status: "completed",
            rawInput: { value: echo },
          },
        });
      }
      if (process.env.T3_ACP_FAIL_PROMPT_TRANSPORT === "exit") process.exit(7);
      if (process.env.T3_ACP_FAIL_PROMPT_WITH_OPEN_TOOL === "1") {
        // The prompt fails as a request error while a tool it started is still running.
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "failing-turn-tool",
            title: "Terminal",
            kind: "execute",
            status: "in_progress",
            rawInput: { command: "sleep 60" },
          },
        });
        return yield* AcpError.AcpRequestError.internalError("Mock prompt failure");
      }
      if (process.env.T3_ACP_FAIL_PROMPT_TRANSPORT === "malformed") {
        process.stdout.write("{malformed-json\n");
        return yield* Effect.never;
      }
      if (process.env.ACP_MOCK_ID_ONLY_PERMISSION === "1") {
        yield* agent.client.sessionUpdate({
          sessionId: "foreign-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tracked-command",
            kind: "execute",
            title: "foreign command",
            status: "pending",
            rawInput: { command: "foreign command" },
          },
        });
        yield* agent.client.requestPermission({
          sessionId: requestedSessionId,
          toolCall: { toolCallId: "tracked-command" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tracked-command",
            kind: "execute",
            title: "git status",
            status: "pending",
            rawInput: {},
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: "foreign-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tracked-command",
            kind: "execute",
            title: "foreign overwrite",
            rawInput: { command: "foreign overwrite" },
          },
        });
        for (const permissionSessionId of ["foreign-session", requestedSessionId]) {
          yield* agent.client.requestPermission({
            sessionId: permissionSessionId,
            toolCall: { toolCallId: "tracked-command" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          });
        }
        return { stopReason: "end_turn" };
      }
      if (process.env.ACP_MOCK_ARGUMENT_STREAM === "1") {
        const toolCallId = "argument-stream";
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            kind: "edit",
            title: "Edit file",
            status: "pending",
            rawInput: { path: "/fixture/file", content: "" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" },
        });
        for (let index = 1; index <= 120; index++)
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              rawInput: { path: "/fixture/file", content: "x".repeat(index) },
            },
          });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: { sessionUpdate: "tool_call_update", toolCallId, title: "Arguments finished" },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            rawOutput: { output: "visible result" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed" },
        });
        return { stopReason: "end_turn" };
      }

      if (process.env.ACP_MOCK_PRIVATE_TOOL_EVENTS === "1") {
        for (const update of [
          {
            sessionUpdate: "tool_call_update" as const,
            toolCallId: "private-update-only",
            title: "Terminal",
            kind: "execute" as const,
            status: "completed" as const,
            rawInput: { command: "echo safe" },
            rawOutput: "PRIVATE_ADAPTER_SENTINEL",
          },
          {
            sessionUpdate: "tool_call" as const,
            toolCallId: "private-task",
            title: "Running start_subagent",
            kind: "other" as const,
            status: "completed" as const,
            rawInput: { text: "PRIVATE_ADAPTER_SENTINEL" },
            rawOutput: "PRIVATE_ADAPTER_SENTINEL",
          },
        ])
          yield* agent.client.sessionUpdate({ sessionId: requestedSessionId, update });
      }

      const promptGate = process.env.T3_ACP_PROMPT_GATE_PATH;
      while (promptGate && !existsSync(promptGate)) yield* Effect.sleep("5 millis");
      if (promptDelayMs > 0) {
        yield* Effect.sleep(`${promptDelayMs} millis`);
      }

      if (exitDuringPrompt) {
        logExit("prompt");
        process.exit(1);
      }

      if (emitToolSpanningTurns) {
        // The first turn ends with a command still running; the second turn
        // reports it finished.
        spanningPromptCount += 1;
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update:
            spanningPromptCount === 1
              ? {
                  sessionUpdate: "tool_call",
                  toolCallId: "spanning-1",
                  title: "Terminal",
                  kind: "execute",
                  status: "in_progress",
                  rawInput: { command: "sleep 60" },
                }
              : {
                  sessionUpdate: "tool_call_update",
                  toolCallId: "spanning-1",
                  status: "completed",
                },
        });
        return { stopReason: "end_turn" };
      }

      if (emitExtensionsAcrossTurns) {
        // The first turn sets a to-do list and leaves a subagent open; the
        // second patches one to-do and reports that subagent finished late.
        extensionsPromptCount += 1;
        if (extensionsPromptCount === 1) {
          yield* agent.client.extRequest("cursor/update_todos", {
            toolCallId: "todos-1",
            merge: false,
            todos: [
              { id: "a", content: "First step", status: "in_progress" },
              { id: "b", content: "Second step", status: "pending" },
            ],
          });
          yield* agent.client.extRequest("cursor/task", {
            toolCallId: "late-task",
            description: "Long child",
            prompt: "Keep going",
          });
        } else {
          yield* agent.client.extRequest("cursor/update_todos", {
            toolCallId: "todos-2",
            merge: true,
            todos: [{ id: "a", status: "completed" }],
          });
          yield* agent.client.extRequest("cursor/task", {
            toolCallId: "late-task",
            description: "Long child",
            prompt: "Keep going",
            durationMs: 5000,
          });
        }
        return { stopReason: "end_turn" };
      }

      if (emitBackgroundToolDuringAnswer) {
        // A command backgrounded earlier reports progress and then finishes
        // while the next answer is still streaming.
        const toolCallId = "background-1";
        const say = (text: string) =>
          agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          });
        const progress = (status: "in_progress" | "completed", stdout: string) =>
          agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status,
              rawOutput: { stdout },
            },
          });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "in_progress",
            rawInput: { command: "sleep 3 && echo done" },
          },
        });
        yield* say("| a | b |\n|---|---|\n| 1 ");
        yield* progress("in_progress", ".");
        yield* say("| x |\n");
        yield* progress("completed", "done");
        yield* say("| 2 | y |\n");
        // Agents can repeat a terminal update after the call finished.
        yield* progress("completed", "done");
        yield* say("| 3 | z |");
        return { stopReason: "end_turn" };
      }

      if (emitInterleavedAssistantToolCalls) {
        const toolCallId = "tool-call-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "before tool" },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["echo", "hello"],
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              exitCode: 0,
              stdout: "hello",
              stderr: "",
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: promptResponseText ?? "after tool" },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (process.env.F5_ACP_ANTIGRAVITY_ELICIT === "1") {
        yield* agent.client.elicit({
          mode: "form",
          sessionId: requestedSessionId,
          message: "Confirm the environment",
          requestedSchema: {
            type: "object",
            properties: { environment: { type: "string" } },
          },
        });
      }
      if (process.env.F5_ACP_ANTIGRAVITY_QUESTION === "1") {
        yield* agent.client.requestPermission({
          sessionId: requestedSessionId,
          toolCall: { toolCallId: "interaction_test", title: "Which environment?" },
          options: [
            { optionId: "dev", name: "Development", kind: "allow_once" },
            { optionId: "prod", name: "Production", kind: "allow_once" },
          ],
        });
      }
      if (emitToolCalls) {
        const toolCallId = "tool-call-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["cat", "server/package.json"],
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });

        let cancelled = false;
        for (let index = 0; index < permissionRequestCount && !cancelled; index++) {
          const command =
            index > 0
              ? (process.env.T3_ACP_SECOND_PERMISSION_COMMAND ?? "cat server/package.json")
              : "cat server/package.json";
          const permissionKind = process.env.T3_ACP_PERMISSION_KIND;
          const antigravityShaped = process.env.T3_ACP_PERMISSION_ANTIGRAVITY_SHAPE === "1";
          const permission = yield* agent.client.requestPermission({
            sessionId: requestedSessionId,
            toolCall: {
              toolCallId: index === 0 ? toolCallId : `${toolCallId}-${index + 1}`,
              // Antigravity names the tool and carries the command in `CommandLine`.
              title: antigravityShaped ? "run_command" : `\`${command}\``,
              ...(permissionKind === "omit"
                ? {}
                : {
                    kind:
                      permissionKind === "null"
                        ? null
                        : ((permissionKind ?? "execute") as AcpSchema.ToolKind),
                  }),
              status: "pending",
              rawInput: antigravityShaped
                ? { CommandLine: command, WaitMsBeforeAsync: 5000 }
                : {
                    variant: "Bash",
                    command,
                    description: index === 0 ? "Read package metadata" : "Read it again",
                  },
              content: [
                {
                  type: "content",
                  content: {
                    type: "text",
                    text: `Not in allowlist: ${command}`,
                  },
                },
              ],
            },
            options: [
              { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              ...(omitAllowAlways
                ? []
                : [
                    {
                      optionId: "allow-always",
                      name: "Allow always",
                      kind: "allow_always" as const,
                    },
                  ]),
              { optionId: "reject-once", name: "Reject", kind: "reject_once" },
            ],
          });

          if (process.env.T3_ACP_WAIT_AFTER_PERMISSION === "1") {
            while (!cancelledSessions.has(requestedSessionId)) yield* Effect.sleep("10 millis");
          }
          cancelled =
            cancelledSessions.delete(requestedSessionId) ||
            permission.outcome.outcome === "cancelled";
        }

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "completed",
            rawOutput: {
              exitCode: 0,
              stdout: '{ "name": "t3" }',
              stderr: "",
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from mock" },
          },
        });

        return { stopReason: cancelled ? "cancelled" : "end_turn" };
      }

      if (emitGenericToolPlaceholders) {
        const toolCallId = "tool-call-generic-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Read File",
            kind: "read",
            status: "pending",
            rawInput: {},
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              content: "package.json\n",
            },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (process.env.T3_ACP_COPILOT_SUBAGENTS === "1") {
        const raw = (type: string, data: Record<string, unknown>, agentId?: string) =>
          agent.client.extNotification("github.com/copilot/sessionEvent", {
            sessionId: requestedSessionId,
            type,
            data,
            ...(agentId ? { agentId } : {}),
          });
        const chunk = (text: string) =>
          agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          });
        yield* raw("subagent.started", { toolCallId: "copilot-task" }, "child-agent");
        yield* raw("assistant.message_delta", {
          parentToolCallId: "copilot-task",
          deltaContent: "PRIVATE_COPILOT_CHILD",
        });
        yield* chunk("PRIVATE_COPILOT_CHILD");
        yield* raw("assistant.message_delta", {
          parentToolCallId: "copilot-task",
          deltaContent: "SAME_CHUNK",
        });
        yield* chunk("SAME_CHUNK");
        yield* raw("assistant.message_delta", { deltaContent: "SAME_CHUNK" });
        yield* chunk("SAME_CHUNK");
        yield* raw("assistant.reasoning_delta", {
          parentToolCallId: "copilot-task",
          deltaContent: "PRIVATE_COPILOT_THOUGHT",
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "PRIVATE_COPILOT_THOUGHT" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "private-child-read",
            title: "Private child read",
            kind: "read",
            status: "in_progress",
            _meta: { "github.com/copilot": { agentId: "child-agent" } },
          },
        });
        yield* raw("subagent.completed", {}, "child-agent");
        yield* raw("assistant.message_delta", { deltaContent: "PUBLIC_PARENT" });
        yield* chunk("PUBLIC_PARENT");
        return { stopReason: "end_turn" };
      }

      if (emitAskQuestion) {
        yield* agent.client.extRequest("cursor/ask_question", {
          toolCallId: "ask-question-tool-call-1",
          title: "Question",
          questions: [
            {
              id: "scope",
              prompt: "Which scope?",
              options: [
                { id: "workspace", label: "Workspace" },
                { id: "session", label: "Session" },
              ],
            },
          ],
        });
        if (emitQuestionFallback) {
          // Cursor re-asks an unreadable answer as a permission request.
          yield* agent.client.requestPermission({
            sessionId: requestedSessionId,
            toolCall: {
              toolCallId: "ask-question-tool-call-1_q0",
              kind: "other",
              title: "Which scope?",
            },
            options: [
              { optionId: "allow-once", name: "Workspace", kind: "allow_once" },
              { optionId: "reject-once", name: "Skip", kind: "reject_once" },
            ],
          });
        }

        return { stopReason: "end_turn" };
      }

      if (emitCursorExtensionRequests) {
        yield* agent.client.extRequest("cursor/update_todos", {
          toolCallId: "todos-1",
          merge: false,
          todos: [
            { id: "a", content: "First step", status: "in_progress" },
            { id: "b", content: "Second step", status: "pending" },
          ],
        });
        yield* agent.client.extRequest("cursor/update_todos", {
          toolCallId: "todos-2",
          merge: true,
          todos: [{ id: "a", status: "completed" }],
        });
        yield* agent.client.extRequest("cursor/task", {
          toolCallId: "task-1",
          description: "Explore the repository",
          prompt: "Find the entry point",
          subagentType: "explore",
        });
        yield* agent.client.extRequest("cursor/task", {
          toolCallId: "task-2",
          description: "Finished child",
          prompt: "Done already",
          subagentType: { custom: "reviewer" },
          durationMs: 1200,
        });
        yield* agent.client.extRequest("cursor/generate_image", {
          toolCallId: "image-1",
          description: "A diagram",
          filePath: "diagram.png",
        });
        yield* agent.client.extRequest("cursor/generate_image", {
          toolCallId: "image-2",
          description: "Outside the workspace",
          filePath: "/etc/outside.png",
        });
        return { stopReason: "end_turn" };
      }

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "plan",
          entries: [
            {
              content: "Inspect mock ACP state",
              priority: "high",
              status: "completed",
            },
            {
              content: "Implement the requested change",
              priority: "high",
              status: "in_progress",
            },
          ],
        },
      });

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: promptResponseText ?? "hello from mock" },
        },
      });

      if (emitUsageFrames) {
        usageUsed += 1200;
        yield* agent.raw.notify("session/update", {
          sessionId: requestedSessionId,
          update: { sessionUpdate: "usage_update", used: usageUsed, size: 1_048_576 },
        });
        // Malformed frames must be ignored by the client.
        yield* agent.raw.notify("session/update", {
          sessionId: requestedSessionId,
          update: { sessionUpdate: "usage_update", used: -1, size: 0 },
        });
      }
      if (postPromptWakeMs > 0) {
        yield* agent.client
          .sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "background work finished" },
            },
          })
          .pipe(Effect.delay(`${postPromptWakeMs} millis`), Effect.ignore, Effect.forkDetach);
      }

      return { stopReason: "end_turn" };
    }),
  );

  yield* agent.handleUnknownExtRequest((method, params) => {
    if (method !== "session/mode/set" && method !== "session/set_mode") {
      return Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
    }

    const nextModeId =
      typeof params === "object" &&
      params !== null &&
      "modeId" in params &&
      typeof params.modeId === "string"
        ? params.modeId
        : typeof params === "object" &&
            params !== null &&
            "mode" in params &&
            typeof params.mode === "string"
          ? params.mode
          : undefined;
    const requestedSessionId =
      typeof params === "object" &&
      params !== null &&
      "sessionId" in params &&
      typeof params.sessionId === "string"
        ? params.sessionId
        : sessionId;

    if (antigravityProfile && typeof nextModeId === "string") {
      if (!antigravityModes().some((mode) => mode.id === nextModeId))
        return Effect.fail(AcpError.AcpRequestError.invalidParams("Unknown mode"));
      antigravityModeId = nextModeId;
      return agent.client
        .sessionUpdate({
          sessionId: requestedSessionId,
          update: { sessionUpdate: "current_mode_update", currentModeId: antigravityModeId },
        })
        .pipe(Effect.as({}));
    }
    if (typeof nextModeId === "string" && nextModeId.trim()) {
      currentModeId = nextModeId.trim();
      saveMode();
      if (process.env.T3_ACP_SUPPRESS_MODE_UPDATE === "1") return Effect.succeed({});
      return agent.client
        .sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId,
          },
        })
        .pipe(Effect.as({}));
    }

    return Effect.succeed({});
  });

  return yield* Effect.never;
}).pipe(
  Effect.provide(
    EffectAcpAgent.layerStdio(
      requestLogPath
        ? {
            logIncoming: true,
            logger: (event) => {
              if (event.direction !== "incoming" || event.stage !== "raw") {
                return Effect.void;
              }
              if (typeof event.payload !== "string") {
                return Effect.void;
              }
              const payload = event.payload;
              return Effect.sync(() => {
                appendFileSync(
                  requestLogPath,
                  payload.endsWith("\n") ? payload : `${payload}\n`,
                  "utf8",
                );
              });
            },
          }
        : {},
    ),
  ),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program);
