import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ApprovalRequestId,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  ThreadId,
} from "@t3tools/contracts";

import {
  buildCodexInitializeParams,
  codexRequestTimeoutMs,
  CodexAppServerManager,
  classifyCodexStderrLine,
  isRecoverableThreadResumeError,
  legacyCodexApprovalDecision,
  normalizeCodexModelSlug,
  readCodexAccountSnapshot,
  readEnabledSkillsFromSkillsListResponse,
  resolveCodexModelForAccount,
} from "./codexAppServerManager";
import {
  buildCodexAssistantInstructions,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "./provider/sharedAssistantContract";
import { fingerprintSupportedSlashCommands } from "./provider/supportedSlashCommands";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const currentDate = () => new Date().toISOString().slice(0, 10);

function createSendTurnHarness(input?: {
  readonly instructionContext?: Record<string, unknown>;
  readonly resumedContextSent?: boolean;
}) {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    account: {
      type: "unknown",
      planType: null,
      sparkEnabled: true,
    },
    ...(input?.instructionContext ? { instructionContext: input.instructionContext } : {}),
    resumedContextSent: input?.resumedContextSent ?? false,
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const sendRequest = vi
    .spyOn(
      manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
      "sendRequest",
    )
    .mockResolvedValue({
      turn: {
        id: "turn_1",
      },
    });
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});

  return { manager, context, requireSession, sendRequest, updateSession };
}

function createThreadControlHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const sendRequest = vi.spyOn(
    manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
    "sendRequest",
  );
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});

  return { manager, context, requireSession, sendRequest, updateSession };
}

function createPendingUserInputHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    pendingUserInputs: new Map([
      [
        ApprovalRequestId.makeUnsafe("req-user-input-1"),
        {
          requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
          jsonRpcId: 42,
          threadId: asThreadId("thread_1"),
        },
      ],
    ]),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const writeMessage = vi
    .spyOn(
      manager as unknown as { writeMessage: (...args: unknown[]) => Promise<void> },
      "writeMessage",
    )
    .mockResolvedValue();
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});

  return { manager, context, requireSession, writeMessage, emitEvent };
}

function createPendingApprovalHarness(
  requestedPermissions: Record<string, unknown> | null = {
    filesystem: { read: true, write: true },
  },
) {
  const requestId = ApprovalRequestId.makeUnsafe("req-permissions-1");
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: asThreadId("thread_1"),
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    pendingApprovals: new Map([
      [
        requestId,
        {
          requestId,
          jsonRpcId: 43,
          method: "item/permissions/requestApproval",
          requestKind: "permission",
          responseKind: "permissions",
          ...(requestedPermissions !== null ? { requestedPermissions } : {}),
          threadId: asThreadId("thread_1"),
        },
      ],
    ]),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const writeMessage = vi
    .spyOn(
      manager as unknown as { writeMessage: (...args: unknown[]) => Promise<void> },
      "writeMessage",
    )
    .mockResolvedValue();
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});

  return { manager, context, requestId, requireSession, writeMessage, emitEvent };
}

function createSkillsRefreshHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: asThreadId("thread_1"),
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      cwd: "/tmp/project",
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    account: {
      type: "unknown",
      planType: null,
      sparkEnabled: true,
    },
    child: {} as never,
    output: {} as never,
    pending: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    instructionContext: {
      cwd: "/tmp/project",
    },
    configuredBase: {
      model: "gpt-5.3-codex",
    },
    availableSkills: [],
    supportedCommandsFingerprint: fingerprintSupportedSlashCommands([]),
    skillsLoaded: false,
    skillRefreshInFlight: false,
    skillRefreshPending: false,
    initialSkillsRetryTimeout: undefined,
    initialSkillsRetryAttempted: false,
    resumedContextSent: false,
    nextRequestId: 1,
    stopping: false,
  };

  (
    manager as unknown as {
      sessions: Map<ThreadId, unknown>;
    }
  ).sessions.set(context.session.threadId, context);

  const sendRequest = vi.spyOn(
    manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
    "sendRequest",
  );
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});

  return { manager, context, sendRequest, emitEvent };
}

describe("classifyCodexStderrLine", () => {
  it("ignores empty lines", () => {
    expect(classifyCodexStderrLine("   ")).toBeNull();
  });

  it("ignores non-error structured codex logs", () => {
    const line =
      "2026-02-08T04:24:19.241256Z  WARN codex_core::features: unknown feature key in config: skills";
    expect(classifyCodexStderrLine(line)).toBeNull();
  });

  it("ignores known benign rollout path errors", () => {
    const line =
      "\u001b[2m2026-02-08T04:24:20.085687Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_core::rollout::list\u001b[0m: state db missing rollout path for thread 019c3b6c-46b8-7b70-ad23-82f824d161fb";
    expect(classifyCodexStderrLine(line)).toBeNull();
  });

  it("ignores opentelemetry exporter noise", () => {
    const line =
      '2026-04-10T15:53:06.704277Z ERROR opentelemetry_sdk:  name="BatchSpanProcessor.Flush.ExportError" reason="InternalFailure(\\"reqwest::Error { kind: Status(400, None), url: \\\\\\"https://otel-mobile.doordash.com/v1/logs\\\\\\" }\\")" Failed during the export process';
    expect(classifyCodexStderrLine(line)).toBeNull();
  });

  it("keeps unknown structured errors", () => {
    const line = "2026-02-08T04:24:20.085687Z ERROR codex_core::runtime: unrecoverable failure";
    expect(classifyCodexStderrLine(line)).toEqual({
      message: line,
    });
  });

  it("keeps plain stderr messages", () => {
    const line = "fatal: permission denied";
    expect(classifyCodexStderrLine(line)).toEqual({
      message: line,
    });
  });
});

describe("normalizeCodexModelSlug", () => {
  it("maps 5.6 aliases to gpt-5.6-sol", () => {
    expect(normalizeCodexModelSlug("5.6")).toBe("gpt-5.6-sol");
    expect(normalizeCodexModelSlug("gpt-5.6")).toBe("gpt-5.6-sol");
    expect(normalizeCodexModelSlug("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  it("maps 5.5 aliases to gpt-5.5", () => {
    expect(normalizeCodexModelSlug("5.5")).toBe("gpt-5.5");
  });

  it("maps 5.3 aliases to gpt-5.3-codex", () => {
    expect(normalizeCodexModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeCodexModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
  });

  it("prefers codex id when model differs", () => {
    expect(normalizeCodexModelSlug("gpt-5.3", "gpt-5.3-codex")).toBe("gpt-5.3-codex");
  });

  it("keeps non-aliased models as-is", () => {
    expect(normalizeCodexModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
    expect(normalizeCodexModelSlug("gpt-5.2")).toBe("gpt-5.2");
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches not-found resume errors", () => {
    expect(
      isRecoverableThreadResumeError(new Error("thread/resume failed: thread not found")),
    ).toBe(true);
  });

  it("ignores non-resume errors", () => {
    expect(
      isRecoverableThreadResumeError(new Error("thread/start failed: permission denied")),
    ).toBe(false);
  });

  it("ignores non-recoverable resume errors", () => {
    expect(
      isRecoverableThreadResumeError(
        new Error("thread/resume failed: timed out waiting for server"),
      ),
    ).toBe(false);
  });
});

describe("readCodexAccountSnapshot", () => {
  it("disables spark for chatgpt plus accounts", () => {
    expect(
      readCodexAccountSnapshot({
        type: "chatgpt",
        email: "plus@example.com",
        planType: "plus",
      }),
    ).toEqual({
      type: "chatgpt",
      planType: "plus",
      sparkEnabled: false,
    });
  });

  it("keeps spark enabled for chatgpt pro accounts", () => {
    expect(
      readCodexAccountSnapshot({
        type: "chatgpt",
        email: "pro@example.com",
        planType: "pro",
      }),
    ).toEqual({
      type: "chatgpt",
      planType: "pro",
      sparkEnabled: true,
    });
  });

  it("keeps spark enabled for api key accounts", () => {
    expect(
      readCodexAccountSnapshot({
        type: "apiKey",
      }),
    ).toEqual({
      type: "apiKey",
      planType: null,
      sparkEnabled: true,
    });
  });
});

describe("resolveCodexModelForAccount", () => {
  it("falls back from spark to default for unsupported chatgpt plans", () => {
    expect(
      resolveCodexModelForAccount("gpt-5.3-codex-spark", {
        type: "chatgpt",
        planType: "plus",
        sparkEnabled: false,
      }),
    ).toBe("gpt-5.3-codex");
  });

  it("keeps spark for supported plans", () => {
    expect(
      resolveCodexModelForAccount("gpt-5.3-codex-spark", {
        type: "chatgpt",
        planType: "pro",
        sparkEnabled: true,
      }),
    ).toBe("gpt-5.3-codex-spark");
  });
});

describe("readEnabledSkillsFromSkillsListResponse", () => {
  it("keeps only enabled skills and prefers interface short descriptions", () => {
    expect(
      readEnabledSkillsFromSkillsListResponse({
        data: [
          {
            cwd: "/tmp/project",
            skills: [
              {
                name: "review",
                description: "Review the current diff in detail",
                shortDescription: "Legacy review",
                interface: {
                  shortDescription: "Review the diff",
                },
                enabled: true,
              },
              {
                name: "disabled",
                description: "Should not surface",
                enabled: false,
              },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        name: "review",
        description: "Review the diff",
      },
    ]);
  });

  it("reports malformed enabled skills to the caller", () => {
    const dropped: string[] = [];

    expect(
      readEnabledSkillsFromSkillsListResponse(
        {
          data: [
            {
              cwd: "/tmp/project",
              skills: [
                {
                  description: "Missing a name",
                  path: "/tmp/project/.codex/skills/unnamed/SKILL.md",
                  enabled: true,
                },
                {
                  name: "missing-description",
                  path: "/tmp/project/.codex/skills/missing-description/SKILL.md",
                  enabled: true,
                },
              ],
            },
          ],
        },
        {
          onDroppedSkill: ({ reason, skill }) => {
            dropped.push(`${reason}:${String(skill.path ?? "unknown")}`);
          },
        },
      ),
    ).toEqual([]);

    expect(dropped).toEqual([
      "missing_name:/tmp/project/.codex/skills/unnamed/SKILL.md",
      "missing_description:/tmp/project/.codex/skills/missing-description/SKILL.md",
    ]);
  });
});

describe("startSession", () => {
  it("uses sixty seconds only for thread open requests", () => {
    expect(codexRequestTimeoutMs("thread/start")).toBe(60_000);
    expect(codexRequestTimeoutMs("thread/resume")).toBe(60_000);
    expect(codexRequestTimeoutMs("turn/start")).toBe(20_000);
  });

  it("enables Codex experimental api capabilities during initialize", () => {
    expect(buildCodexInitializeParams()).toEqual({
      clientInfo: {
        name: "t3code_desktop",
        title: "F5 Desktop",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        optOutNotificationMethods: ["hook/started"],
      },
    });
  });

  it("emits session/startFailed when resolving cwd throws before process launch", async () => {
    const manager = new CodexAppServerManager();
    const events: Array<{ method: string; kind: string; message?: string }> = [];
    manager.on("event", (event) => {
      events.push({
        method: event.method,
        kind: event.kind,
        ...(event.message ? { message: event.message } : {}),
      });
    });

    const processCwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("cwd missing");
    });
    try {
      await expect(
        manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "codex",
          runtimeMode: "full-access",
        }),
      ).rejects.toThrow("cwd missing");
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        method: "session/startFailed",
        kind: "error",
        message: "cwd missing",
      });
    } finally {
      processCwd.mockRestore();
      manager.stopAll();
    }
  });

  it("fails fast with an upgrade message when codex is below the minimum supported version", async () => {
    const manager = new CodexAppServerManager();
    const events: Array<{ method: string; kind: string; message?: string }> = [];
    manager.on("event", (event) => {
      events.push({
        method: event.method,
        kind: event.kind,
        ...(event.message ? { message: event.message } : {}),
      });
    });

    const versionCheck = vi
      .spyOn(
        manager as unknown as {
          assertSupportedCodexCliVersion: (input: {
            binaryPath: string;
            cwd: string;
            homePath?: string;
          }) => void;
        },
        "assertSupportedCodexCliVersion",
      )
      .mockImplementation(() => {
        throw new Error(
          "Codex CLI v0.36.0 is too old for F5. Upgrade to v0.37.0 or newer and restart F5.",
        );
      });

    try {
      await expect(
        manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "codex",
          runtimeMode: "full-access",
        }),
      ).rejects.toThrow(
        "Codex CLI v0.36.0 is too old for F5. Upgrade to v0.37.0 or newer and restart F5.",
      );
      expect(versionCheck).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        {
          method: "session/startFailed",
          kind: "error",
          message:
            "Codex CLI v0.36.0 is too old for F5. Upgrade to v0.37.0 or newer and restart F5.",
        },
      ]);
    } finally {
      versionCheck.mockRestore();
      manager.stopAll();
    }
  });
});

describe("sendTurn", () => {
  it("sends text and image user input items to turn/start", async () => {
    const { manager, context, requireSession, sendRequest, updateSession } =
      createSendTurnHarness();
    const today = currentDate();

    const result = await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Inspect this image",
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
        },
      ],
      model: "gpt-5.3",
      serviceTier: "fast",
      effort: "high",
    });

    expect(result).toEqual({
      threadId: "thread_1",
      turnId: "turn_1",
      resumeCursor: { threadId: "thread_1" },
    });
    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      input: [
        {
          type: "text",
          text: "Inspect this image",
          text_elements: [],
        },
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
        },
      ],
      model: "gpt-5.3-codex",
      serviceTier: "fast",
      effort: "high",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "high",
          developer_instructions: buildCodexAssistantInstructions({
            interactionMode: "default",
            currentDate: today,
            model: "gpt-5.3-codex",
            effort: "high",
          }),
        },
      },
    });
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "running",
      model: "gpt-5.3-codex",
      activeTurnId: "turn_1",
      resumeCursor: { threadId: "thread_1" },
    });
  });

  it("supports image-only turns", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    const today = currentDate();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,BBBB",
        },
      ],
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      input: [
        {
          type: "image",
          url: "data:image/png;base64,BBBB",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexAssistantInstructions({
            interactionMode: "default",
            currentDate: today,
            model: "gpt-5.3-codex",
          }),
        },
      },
    });
  });

  it("falls back to the shared Codex default when the session has no explicit model", async () => {
    const { manager, context, sendRequest, updateSession } = createSendTurnHarness();
    const today = currentDate();
    delete (context.session as { model?: string }).model;

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Continue the work",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      input: [
        {
          type: "text",
          text: "Continue the work",
          text_elements: [],
        },
      ],
      model: DEFAULT_MODEL_BY_PROVIDER.codex,
      collaborationMode: {
        mode: "default",
        settings: {
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          reasoning_effort: "medium",
          developer_instructions: buildCodexAssistantInstructions({
            interactionMode: "default",
            currentDate: today,
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          }),
        },
      },
    });
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "running",
      model: DEFAULT_MODEL_BY_PROVIDER.codex,
      activeTurnId: "turn_1",
      resumeCursor: { threadId: "thread_1" },
    });
  });

  it("passes Codex plan mode as a collaboration preset on turn/start", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    const today = currentDate();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Plan the work",
      interactionMode: "plan",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      input: [
        {
          type: "text",
          text: "Plan the work",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexAssistantInstructions({
            interactionMode: "plan",
            currentDate: today,
            model: "gpt-5.3-codex",
          }),
        },
      },
    });
  });

  it("passes Codex default mode as a collaboration preset on turn/start", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    const today = currentDate();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "PLEASE IMPLEMENT THIS PLAN:\n- step 1",
      interactionMode: "default",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      input: [
        {
          type: "text",
          text: "PLEASE IMPLEMENT THIS PLAN:\n- step 1",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexAssistantInstructions({
            interactionMode: "default",
            currentDate: today,
            model: "gpt-5.3-codex",
          }),
        },
      },
    });
  });

  it("keeps the session model when interaction mode is set without an explicit model", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    const today = currentDate();
    context.session.model = "gpt-5.2-codex";

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Plan this with my current session model",
      interactionMode: "plan",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      input: [
        {
          type: "text",
          text: "Plan this with my current session model",
          text_elements: [],
        },
      ],
      model: "gpt-5.2-codex",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.2-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexAssistantInstructions({
            interactionMode: "plan",
            currentDate: today,
            model: "gpt-5.2-codex",
          }),
        },
      },
    });
  });

  it("includes resumed context only on the first Codex turn", async () => {
    const { manager, sendRequest } = createSendTurnHarness({
      instructionContext: {
        projectTitle: "F3 Code",
        threadTitle: "Recovery thread",
        turnCount: 5,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
        priorWorkSummary: "Summary:\nPrevious work",
        restoredTasks: ["[pending] Finish the patch"],
      },
    });

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Continue the work",
    });
    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Continue again",
    });

    const firstParams = sendRequest.mock.calls[0]?.[2] as {
      collaborationMode?: { settings: { developer_instructions: string } };
    };
    const secondParams = sendRequest.mock.calls[1]?.[2] as {
      collaborationMode?: { settings: { developer_instructions: string } };
    };

    expect(firstParams.collaborationMode?.settings.developer_instructions).toContain(
      "### Prior Work Summary",
    );
    expect(firstParams.collaborationMode?.settings.developer_instructions).toContain(
      "### Restored Task Snapshot",
    );
    expect(secondParams.collaborationMode?.settings.developer_instructions).not.toContain(
      "### Prior Work Summary",
    );
    expect(secondParams.collaborationMode?.settings.developer_instructions).not.toContain(
      "### Restored Task Snapshot",
    );
  });

  it("omits resumed context when the provider thread was actually resumed", async () => {
    const { manager, sendRequest } = createSendTurnHarness({
      instructionContext: {
        projectTitle: "F3 Code",
        threadTitle: "Recovery thread",
        turnCount: 5,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
        priorWorkSummary: "Summary:\nPrevious work",
        restoredTasks: ["[pending] Finish the patch"],
      },
      resumedContextSent: true,
    });

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Continue the work",
    });

    const params = sendRequest.mock.calls[0]?.[2] as {
      collaborationMode?: { settings: { developer_instructions: string } };
    };

    expect(params.collaborationMode?.settings.developer_instructions).not.toContain(
      "### Prior Work Summary",
    );
    expect(params.collaborationMode?.settings.developer_instructions).not.toContain(
      "### Restored Task Snapshot",
    );
  });

  it("composes shared Codex instructions with the detailed plan mode prompt", () => {
    const instructions = buildCodexAssistantInstructions({
      interactionMode: "plan",
      model: "gpt-5.3-codex",
    });

    expect(instructions).toContain("If the user asks what model you are");
    expect(instructions).toContain("<proposed_plan>");
    expect(instructions).toContain(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS);
  });

  it("composes shared Codex instructions with the detailed default mode prompt", () => {
    const instructions = buildCodexAssistantInstructions({
      interactionMode: "default",
      model: "gpt-5.3-codex",
    });

    expect(instructions).toContain("If the user asks what model you are");
    expect(instructions).toContain("request_user_input");
    expect(instructions).toContain(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS);
  });

  it("rejects empty turn input", async () => {
    const { manager } = createSendTurnHarness();

    await expect(
      manager.sendTurn({
        threadId: asThreadId("thread_1"),
      }),
    ).rejects.toThrow("Turn input must include text or attachments.");
  });
});

describe("skills refresh", () => {
  it("emits a follow-up session/configured event with slashCommands after Codex skills load", async () => {
    const { manager, context, sendRequest, emitEvent } = createSkillsRefreshHarness();

    sendRequest.mockResolvedValue({
      data: [
        {
          cwd: "/tmp/project",
          skills: [
            {
              name: "review",
              description: "Review the current diff in detail",
              interface: {
                shortDescription: "Review the diff",
              },
              enabled: true,
            },
          ],
        },
      ],
    });

    (
      manager as unknown as {
        emitSessionConfigured: (context: unknown, config: Record<string, unknown>) => void;
      }
    ).emitSessionConfigured(context, {
      model: "gpt-5.3-codex",
    });

    await (
      manager as unknown as {
        runSkillsRefresh: (
          context: unknown,
          options: { readonly forceReload: boolean },
        ) => Promise<void>;
      }
    ).runSkillsRefresh(context, { forceReload: false });

    expect(emitEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "session/configured",
        payload: {
          config: {
            model: "gpt-5.3-codex",
          },
        },
      }),
    );
    expect(sendRequest).toHaveBeenCalledWith(
      context,
      "skills/list",
      {
        cwds: ["/tmp/project"],
        forceReload: false,
      },
      5_000,
    );
    expect(context.skillsLoaded).toBe(true);
    expect(context.availableSkills).toEqual([
      {
        name: "review",
        description: "Review the diff",
      },
    ]);
    expect(emitEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "session/configured",
        payload: {
          config: {
            model: "gpt-5.3-codex",
            slashCommands: [
              {
                name: "review",
                description: "Review the diff",
              },
            ],
          },
        },
      }),
    );
  });

  it("retries the initial skills refresh once after a startup failure", async () => {
    vi.useFakeTimers();
    try {
      const { manager, context, sendRequest } = createSkillsRefreshHarness();

      sendRequest.mockRejectedValueOnce(new Error("skills/list timed out")).mockResolvedValueOnce({
        data: [
          {
            cwd: "/tmp/project",
            skills: [
              {
                name: "review",
                description: "Review the diff",
                enabled: true,
              },
            ],
          },
        ],
      });

      (
        manager as unknown as {
          scheduleSkillsRefresh: (
            context: unknown,
            options: { readonly forceReload: boolean },
          ) => void;
        }
      ).scheduleSkillsRefresh(context, { forceReload: false });

      await Promise.resolve();
      expect(sendRequest).toHaveBeenCalledTimes(1);
      expect(context.initialSkillsRetryAttempted).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);

      expect(context.initialSkillsRetryAttempted).toBe(true);
      expect(context.skillsLoaded).toBe(true);
      expect(context.availableSkills).toEqual([
        {
          name: "review",
          description: "Review the diff",
        },
      ]);
      expect(sendRequest).toHaveBeenNthCalledWith(
        2,
        context,
        "skills/list",
        {
          cwds: ["/tmp/project"],
          forceReload: true,
        },
        5_000,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops Codex skills that cannot round-trip through the slash UI", async () => {
    const { manager, context, sendRequest, emitEvent } = createSkillsRefreshHarness();

    sendRequest.mockResolvedValue({
      data: [
        {
          cwd: "/tmp/project",
          skills: [
            {
              name: "review diff",
              description: "Contains whitespace",
              enabled: true,
            },
            {
              name: "$review",
              description: "Contains a sigil",
              enabled: true,
            },
            {
              name: "Plan",
              description: "Collides with a reserved host command",
              enabled: true,
            },
            {
              name: "review",
              description: "Review the diff",
              enabled: true,
            },
          ],
        },
      ],
    });

    await (
      manager as unknown as {
        runSkillsRefresh: (
          context: unknown,
          options: { readonly forceReload: boolean },
        ) => Promise<void>;
      }
    ).runSkillsRefresh(context, { forceReload: false });

    expect(context.availableSkills).toEqual([
      {
        name: "review",
        description: "Review the diff",
      },
    ]);
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "session/configured",
        payload: {
          config: {
            model: "gpt-5.3-codex",
            slashCommands: [
              {
                name: "review",
                description: "Review the diff",
              },
            ],
          },
        },
      }),
    );
  });

  it("coalesces skills/changed notifications while a refresh is already running", () => {
    const { manager, context } = createSkillsRefreshHarness();
    const scheduleSkillsRefresh = vi
      .spyOn(
        manager as unknown as {
          scheduleSkillsRefresh: (
            context: unknown,
            options: { readonly forceReload: boolean },
          ) => void;
        },
        "scheduleSkillsRefresh",
      )
      .mockImplementation(() => {});

    context.skillRefreshInFlight = true;

    (
      manager as unknown as {
        handleServerNotification: (
          context: unknown,
          notification: { method: string; params?: unknown },
        ) => void;
      }
    ).handleServerNotification(context, {
      method: "skills/changed",
      params: {},
    });

    expect(context.skillRefreshPending).toBe(true);
    expect(scheduleSkillsRefresh).not.toHaveBeenCalled();
  });

  it("does not emit redundant config updates when Codex skills are unchanged", async () => {
    const { manager, context, sendRequest, emitEvent } = createSkillsRefreshHarness();

    sendRequest.mockResolvedValue({
      data: [
        {
          cwd: "/tmp/project",
          skills: [
            {
              name: "review",
              description: "Review the diff",
              enabled: true,
            },
          ],
        },
      ],
    });

    await (
      manager as unknown as {
        runSkillsRefresh: (
          context: unknown,
          options: { readonly forceReload: boolean },
        ) => Promise<void>;
      }
    ).runSkillsRefresh(context, { forceReload: false });

    emitEvent.mockClear();

    await (
      manager as unknown as {
        runSkillsRefresh: (
          context: unknown,
          options: { readonly forceReload: boolean },
        ) => Promise<void>;
      }
    ).runSkillsRefresh(context, { forceReload: true });

    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("emits slashCommands: [] when Codex skills are later cleared", async () => {
    const { manager, context, sendRequest, emitEvent } = createSkillsRefreshHarness();

    sendRequest
      .mockResolvedValueOnce({
        data: [
          {
            cwd: "/tmp/project",
            skills: [
              {
                name: "review",
                description: "Review the diff",
                enabled: true,
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        data: [
          {
            cwd: "/tmp/project",
            skills: [],
          },
        ],
      });

    await (
      manager as unknown as {
        runSkillsRefresh: (
          context: unknown,
          options: { readonly forceReload: boolean },
        ) => Promise<void>;
      }
    ).runSkillsRefresh(context, { forceReload: false });

    emitEvent.mockClear();

    await (
      manager as unknown as {
        runSkillsRefresh: (
          context: unknown,
          options: { readonly forceReload: boolean },
        ) => Promise<void>;
      }
    ).runSkillsRefresh(context, { forceReload: true });

    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "session/configured",
        payload: {
          config: {
            model: "gpt-5.3-codex",
            slashCommands: [],
          },
        },
      }),
    );
  });

  it("bails out before updating skills when the session has been torn down", async () => {
    const { manager, context, sendRequest, emitEvent } = createSkillsRefreshHarness();

    sendRequest.mockImplementation(async () => {
      (
        manager as unknown as {
          sessions: Map<ThreadId, unknown>;
        }
      ).sessions.delete(context.session.threadId);
      return {
        data: [
          {
            cwd: "/tmp/project",
            skills: [
              {
                name: "review",
                description: "Review the diff",
                enabled: true,
              },
            ],
          },
        ],
      };
    });

    await (
      manager as unknown as {
        runSkillsRefresh: (
          context: unknown,
          options: { readonly forceReload: boolean },
        ) => Promise<void>;
      }
    ).runSkillsRefresh(context, { forceReload: false });

    expect(context.skillsLoaded).toBe(false);
    expect(emitEvent).not.toHaveBeenCalled();
  });
});

describe("runOneOffPrompt", () => {
  it("collects assistant deltas from a synthetic Codex session", async () => {
    const manager = new CodexAppServerManager();
    const stopSession = vi
      .spyOn(manager, "stopSession")
      .mockImplementation(() => undefined as void);
    vi.spyOn(manager, "startSession").mockImplementation(async (input) => ({
      provider: "codex",
      status: "ready",
      runtimeMode: input.runtimeMode,
      threadId: input.threadId,
      cwd: input.cwd,
      createdAt: "2026-04-08T10:00:00.000Z",
      updatedAt: "2026-04-08T10:00:00.000Z",
    }));
    vi.spyOn(manager, "sendTurn").mockImplementation(async (input) => {
      queueMicrotask(() => {
        manager.emit("event", {
          id: asEventId(`evt-${randomUUID()}`),
          kind: "notification",
          provider: "codex",
          threadId: input.threadId,
          createdAt: "2026-04-08T10:00:01.000Z",
          method: "item/agentMessage/delta",
          textDelta: "hello world",
          payload: {
            delta: "hello world",
          },
        });
        manager.emit("event", {
          id: asEventId(`evt-${randomUUID()}`),
          kind: "notification",
          provider: "codex",
          threadId: input.threadId,
          createdAt: "2026-04-08T10:00:02.000Z",
          method: "turn/completed",
          payload: {
            turn: {
              status: "completed",
            },
          },
        });
      });

      return {
        threadId: input.threadId,
        turnId: "turn-one-off" as never,
      };
    });

    const text = await manager.runOneOffPrompt({
      prompt: "Summarize the thread",
      cwd: "/tmp/project",
      model: "gpt-5.3-codex",
      timeoutMs: 1_000,
    });

    expect(text).toBe("hello world");
    expect(manager.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: expect.stringMatching(/^one-off:/),
        runtimeMode: "approval-required",
        cwd: "/tmp/project",
        model: "gpt-5.3-codex",
      }),
    );
    expect(manager.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: expect.stringMatching(/^one-off:/),
        input: "Summarize the thread",
      }),
    );
    expect(stopSession).toHaveBeenCalledWith(expect.stringMatching(/^one-off:/));
  });

  it("fails when the synthetic turn completes without assistant text", async () => {
    const manager = new CodexAppServerManager();
    vi.spyOn(manager, "stopSession").mockImplementation(() => undefined as void);
    vi.spyOn(manager, "startSession").mockImplementation(async (input) => ({
      provider: "codex",
      status: "ready",
      runtimeMode: input.runtimeMode,
      threadId: input.threadId,
      createdAt: "2026-04-08T10:00:00.000Z",
      updatedAt: "2026-04-08T10:00:00.000Z",
    }));
    vi.spyOn(manager, "sendTurn").mockImplementation(async (input) => {
      queueMicrotask(() => {
        manager.emit("event", {
          id: asEventId(`evt-${randomUUID()}`),
          kind: "notification",
          provider: "codex",
          threadId: input.threadId,
          createdAt: "2026-04-08T10:00:02.000Z",
          method: "turn/completed",
          payload: {
            turn: {
              status: "completed",
            },
          },
        });
      });
      return {
        threadId: input.threadId,
        turnId: "turn-one-off" as never,
      };
    });

    await expect(
      manager.runOneOffPrompt({
        prompt: "Summarize the thread",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("Codex one-off prompt completed without returning any assistant text.");
  });

  it("falls back to final assistant text snapshots when no deltas are streamed", async () => {
    const manager = new CodexAppServerManager();
    vi.spyOn(manager, "stopSession").mockImplementation(() => undefined as void);
    vi.spyOn(manager, "startSession").mockImplementation(async (input) => ({
      provider: "codex",
      status: "ready",
      runtimeMode: input.runtimeMode,
      threadId: input.threadId,
      createdAt: "2026-04-08T10:00:00.000Z",
      updatedAt: "2026-04-08T10:00:00.000Z",
    }));
    vi.spyOn(manager, "sendTurn").mockImplementation(async (input) => {
      queueMicrotask(() => {
        manager.emit("event", {
          id: asEventId(`evt-${randomUUID()}`),
          kind: "notification",
          provider: "codex",
          threadId: input.threadId,
          createdAt: "2026-04-08T10:00:01.000Z",
          method: "item/completed",
          payload: {
            item: {
              text: "final snapshot text",
            },
          },
        });
        manager.emit("event", {
          id: asEventId(`evt-${randomUUID()}`),
          kind: "notification",
          provider: "codex",
          threadId: input.threadId,
          createdAt: "2026-04-08T10:00:02.000Z",
          method: "turn/completed",
          payload: {
            turn: {
              status: "completed",
            },
          },
        });
      });

      return {
        threadId: input.threadId,
        turnId: "turn-one-off" as never,
      };
    });

    await expect(
      manager.runOneOffPrompt({
        prompt: "Summarize the thread",
        timeoutMs: 1_000,
      }),
    ).resolves.toBe("final snapshot text");
  });

  it("rejects non-completed terminal turn statuses", async () => {
    const manager = new CodexAppServerManager();
    vi.spyOn(manager, "stopSession").mockImplementation(() => undefined as void);
    vi.spyOn(manager, "startSession").mockImplementation(async (input) => ({
      provider: "codex",
      status: "ready",
      runtimeMode: input.runtimeMode,
      threadId: input.threadId,
      createdAt: "2026-04-08T10:00:00.000Z",
      updatedAt: "2026-04-08T10:00:00.000Z",
    }));
    vi.spyOn(manager, "sendTurn").mockImplementation(async (input) => {
      queueMicrotask(() => {
        manager.emit("event", {
          id: asEventId(`evt-${randomUUID()}`),
          kind: "notification",
          provider: "codex",
          threadId: input.threadId,
          createdAt: "2026-04-08T10:00:02.000Z",
          method: "turn/completed",
          payload: {
            turn: {
              status: "cancelled",
            },
          },
        });
      });
      return {
        threadId: input.threadId,
        turnId: "turn-one-off" as never,
      };
    });

    await expect(
      manager.runOneOffPrompt({
        prompt: "Summarize the thread",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("Unexpected Codex one-off prompt status: cancelled.");
  });

  it("times out if the synthetic turn never completes", async () => {
    const manager = new CodexAppServerManager();
    vi.spyOn(manager, "stopSession").mockImplementation(() => undefined as void);
    vi.spyOn(manager, "startSession").mockImplementation(async (input) => ({
      provider: "codex",
      status: "ready",
      runtimeMode: input.runtimeMode,
      threadId: input.threadId,
      createdAt: "2026-04-08T10:00:00.000Z",
      updatedAt: "2026-04-08T10:00:00.000Z",
    }));
    vi.spyOn(manager, "sendTurn").mockResolvedValue({
      threadId: asThreadId("one-off:test"),
      turnId: "turn-one-off" as never,
    });

    await expect(
      manager.runOneOffPrompt({
        prompt: "Summarize the thread",
        timeoutMs: 10,
      }),
    ).rejects.toThrow("Timed out waiting for Codex one-off prompt completion after 10ms.");
  });
});

describe("thread checkpoint control", () => {
  it("reads thread turns from thread/read", async () => {
    const { manager, context, requireSession, sendRequest } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      thread: {
        id: "thread_1",
        turns: [
          {
            id: "turn_1",
            items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
          },
        ],
      },
    });

    const result = await manager.readThread(asThreadId("thread_1"));

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(sendRequest).toHaveBeenCalledWith(context, "thread/read", {
      threadId: "thread_1",
      includeTurns: true,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });
  });

  it("reads thread turns from flat thread/read responses", async () => {
    const { manager, context, sendRequest } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      threadId: "thread_1",
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });

    const result = await manager.readThread(asThreadId("thread_1"));

    expect(sendRequest).toHaveBeenCalledWith(context, "thread/read", {
      threadId: "thread_1",
      includeTurns: true,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });
  });

  it("rolls back turns via thread/rollback and resets session running state", async () => {
    const { manager, context, sendRequest, updateSession } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      thread: {
        id: "thread_1",
        turns: [],
      },
    });

    const result = await manager.rollbackThread(asThreadId("thread_1"), 2);

    expect(sendRequest).toHaveBeenCalledWith(context, "thread/rollback", {
      threadId: "thread_1",
      numTurns: 2,
    });
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "ready",
      activeTurnId: undefined,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      turns: [],
    });
  });
});

describe("respondToRequest", () => {
  it.each([
    ["accept", "approved"],
    ["acceptForSession", "approved_for_session"],
    ["decline", "denied"],
    ["cancel", "abort"],
  ] as const)("translates legacy approval decision %s", (decision, expected) => {
    expect(legacyCodexApprovalDecision(decision)).toBe(expected);
  });

  it.each([
    [
      "accept",
      "accept",
      {
        permissions: {
          filesystem: { read: true, write: true },
        },
      },
    ],
    [
      "acceptForSession",
      "acceptForSession",
      {
        scope: "session",
        permissions: {
          filesystem: { read: true, write: true },
        },
      },
    ],
    ["decline", "decline", { permissions: {} }],
    ["cancel", "cancel", { permissions: {} }],
  ] as const)(
    "serializes Codex permission approval decision %s",
    async (_label, decision, result) => {
      const { manager, context, requestId, requireSession, writeMessage, emitEvent } =
        createPendingApprovalHarness();

      await manager.respondToRequest(asThreadId("thread_1"), requestId, decision);

      expect(requireSession).toHaveBeenCalledWith("thread_1");
      expect(writeMessage).toHaveBeenCalledWith(context, {
        id: 43,
        result,
      });
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "item/requestApproval/decision",
          requestKind: "permission",
          payload: {
            requestId: "req-permissions-1",
            requestKind: "permission",
            requestMethod: "item/permissions/requestApproval",
            decision,
          },
        }),
      );
    },
  );

  it("serializes malformed Codex permission approvals as empty grants", async () => {
    const { manager, context, requestId, requireSession, writeMessage, emitEvent } =
      createPendingApprovalHarness(null);

    await manager.respondToRequest(asThreadId("thread_1"), requestId, "accept");

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 43,
      result: {
        permissions: {},
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/requestApproval/decision",
        requestKind: "permission",
        payload: {
          requestId: "req-permissions-1",
          requestKind: "permission",
          requestMethod: "item/permissions/requestApproval",
          decision: "accept",
        },
      }),
    );
  });

  it("retains approval state when the JSON-RPC response write fails", async () => {
    const { manager, context, requestId, writeMessage, emitEvent } = createPendingApprovalHarness();
    writeMessage.mockRejectedValueOnce(new Error("stdin disconnected"));

    await expect(
      manager.respondToRequest(asThreadId("thread_1"), requestId, "accept"),
    ).rejects.toThrow("stdin disconnected");

    expect(context.pendingApprovals.has(requestId)).toBe(true);
    expect(
      (
        context as typeof context & {
          nativeRequestCorrelations: Map<string, { resolvedLocally: boolean }>;
        }
      ).nativeRequestCorrelations.get("43")?.resolvedLocally,
    ).toBe(false);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("lets a provider resolution win a race with an in-flight approval write", async () => {
    const { manager, context, requestId, writeMessage, emitEvent } = createPendingApprovalHarness();
    let finishWrite: (() => void) | undefined;
    writeMessage.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );

    const response = manager.respondToRequest(asThreadId("thread_1"), requestId, "accept");
    await vi.waitFor(() => expect(writeMessage).toHaveBeenCalledOnce());
    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "serverRequest/resolved",
      params: { requestId: 43 },
    });
    finishWrite?.();
    await response;

    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ method: "serverRequest/resolved" }),
    );
    expect(context.pendingApprovals.has(requestId)).toBe(false);
  });

  it.each([
    ["accept", "approved"],
    ["acceptForSession", "approved_for_session"],
    ["decline", "denied"],
    ["cancel", "abort"],
  ] as const)("serializes legacy exec approval %s", async (decision, translated) => {
    const manager = new CodexAppServerManager();
    const requestId = ApprovalRequestId.makeUnsafe("req-legacy-exec");
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: asThreadId("thread_1"),
        runtimeMode: "full-access",
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      pendingApprovals: new Map([
        [
          requestId,
          {
            requestId,
            jsonRpcId: 81,
            method: "execCommandApproval",
            requestKind: "command",
            responseKind: "legacy-decision",
            threadId: asThreadId("thread_1"),
          },
        ],
      ]),
      nativeRequestCorrelations: new Map(),
    };
    vi.spyOn(
      manager as unknown as { requireSession: (threadId: ThreadId) => unknown },
      "requireSession",
    ).mockReturnValue(context);
    const writeMessage = vi
      .spyOn(
        manager as unknown as { writeMessage: (...args: unknown[]) => Promise<void> },
        "writeMessage",
      )
      .mockResolvedValue();
    vi.spyOn(
      manager as unknown as { emitEvent: (...args: unknown[]) => void },
      "emitEvent",
    ).mockImplementation(() => {});

    await manager.respondToRequest(asThreadId("thread_1"), requestId, decision);

    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 81,
      result: { decision: translated },
    });
  });
});

describe("Codex server requests", () => {
  function requestContext() {
    return {
      session: {
        provider: "codex",
        status: "ready",
        threadId: asThreadId("thread_1"),
        runtimeMode: "full-access",
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      nativeRequestCorrelations: new Map(),
    };
  }

  it("routes legacy callId fields to provider items", () => {
    const manager = new CodexAppServerManager();
    const context = requestContext();
    (
      manager as unknown as {
        handleServerRequest: (context: unknown, request: Record<string, unknown>) => void;
      }
    ).handleServerRequest(context, {
      id: 82,
      method: "execCommandApproval",
      params: {
        conversationId: "thread_1",
        callId: "exec-legacy-1",
        command: ["git", "status"],
      },
    });

    const pending = Array.from(context.pendingApprovals.values())[0] as
      | Record<string, unknown>
      | undefined;
    expect(pending).toMatchObject({
      method: "execCommandApproval",
      requestKind: "command",
      responseKind: "legacy-decision",
      itemId: "exec-legacy-1",
    });
    expect(context.nativeRequestCorrelations.size).toBe(1);
  });

  it("bounds native request correlations while retaining the newest prompts", () => {
    const manager = new CodexAppServerManager();
    const context = requestContext();
    const handleServerRequest = (
      manager as unknown as {
        handleServerRequest: (context: unknown, request: Record<string, unknown>) => void;
      }
    ).handleServerRequest.bind(manager);

    for (let requestId = 1; requestId <= 300; requestId += 1) {
      handleServerRequest(context, {
        id: requestId,
        method: "execCommandApproval",
        params: {
          conversationId: "thread_1",
          callId: `exec-${requestId}`,
          command: ["echo", String(requestId)],
        },
      });
    }

    expect(context.nativeRequestCorrelations.size).toBe(256);
    expect(context.nativeRequestCorrelations.has("44")).toBe(false);
    expect(context.nativeRequestCorrelations.has("45")).toBe(true);
    expect(context.nativeRequestCorrelations.has("300")).toBe(true);

    const events: Array<Record<string, unknown>> = [];
    manager.on("event", (event) => events.push(event as unknown as Record<string, unknown>));
    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "serverRequest/resolved",
      params: { threadId: "thread_1", requestId: 1 },
    });

    expect(context.pendingApprovals.size).toBe(299);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: "serverRequest/resolved",
      requestKind: "command",
      itemId: "exec-1",
      payload: {
        request: { method: "execCommandApproval", kind: "command" },
        resolutionSource: "server",
      },
    });
  });

  it("answers currentTime/read without creating a prompt", async () => {
    const manager = new CodexAppServerManager();
    const context = requestContext();
    const writeMessage = vi
      .spyOn(
        manager as unknown as { writeMessage: (...args: unknown[]) => Promise<void> },
        "writeMessage",
      )
      .mockResolvedValue();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_750_000_000_999);
    try {
      (
        manager as unknown as {
          handleServerRequest: (context: unknown, request: Record<string, unknown>) => void;
        }
      ).handleServerRequest(context, { id: 83, method: "currentTime/read", params: {} });

      await vi.waitFor(() => {
        expect(writeMessage).toHaveBeenCalledWith(context, {
          id: 83,
          result: { currentTimeAt: 1_750_000_000 },
        });
      });
    } finally {
      dateNow.mockRestore();
    }
    expect(context.pendingApprovals.size).toBe(0);
    expect(context.pendingUserInputs.size).toBe(0);
  });

  it("cancels unsupported MCP elicitations and emits an actionable warning", async () => {
    const manager = new CodexAppServerManager();
    const context = requestContext();
    const events: Array<{ method: string; message?: string }> = [];
    manager.on("event", (event) =>
      events.push({
        method: event.method,
        ...(event.message === undefined ? {} : { message: event.message }),
      }),
    );
    const writeMessage = vi
      .spyOn(
        manager as unknown as { writeMessage: (...args: unknown[]) => Promise<void> },
        "writeMessage",
      )
      .mockResolvedValue();
    (
      manager as unknown as {
        handleServerRequest: (context: unknown, request: Record<string, unknown>) => void;
      }
    ).handleServerRequest(context, {
      id: 84,
      method: "mcpServer/elicitation/request",
      params: { mode: "form", serverName: "example", message: "Pick a value" },
    });

    await vi.waitFor(() => {
      expect(writeMessage).toHaveBeenCalledWith(context, {
        id: 84,
        result: { action: "cancel", content: null, _meta: null },
      });
    });
    expect(events).toEqual([
      expect.objectContaining({
        method: "protocol/unsupportedServerRequest",
        message: expect.stringContaining("does not support yet"),
      }),
    ]);
  });

  it.each([
    ["item/tool/call", "dynamic tool"],
    ["account/chatgptAuthTokens/refresh", "auth-token refresh"],
    ["attestation/generate", "attestation"],
  ] as const)("rejects unexpected %s requests deterministically", async (method, messagePart) => {
    const manager = new CodexAppServerManager();
    const context = requestContext();
    const events: Array<{ method: string; message?: string }> = [];
    manager.on("event", (event) =>
      events.push({
        method: event.method,
        ...(event.message === undefined ? {} : { message: event.message }),
      }),
    );
    const writeMessage = vi
      .spyOn(
        manager as unknown as { writeMessage: (...args: unknown[]) => Promise<void> },
        "writeMessage",
      )
      .mockResolvedValue();

    (
      manager as unknown as {
        handleServerRequest: (context: unknown, request: Record<string, unknown>) => void;
      }
    ).handleServerRequest(context, { id: 90, method, params: {} });

    await vi.waitFor(() => {
      expect(writeMessage).toHaveBeenCalledWith(context, {
        id: 90,
        error: {
          code: -32000,
          message: expect.stringContaining(messagePart),
        },
      });
    });
    expect(events).toEqual([
      expect.objectContaining({
        method: "protocol/unsupportedServerRequest",
        message: expect.stringContaining(messagePart),
      }),
    ]);
  });

  it("clears externally resolved prompts while preserving request type", () => {
    const manager = new CodexAppServerManager();
    const context = requestContext();
    const requestId = ApprovalRequestId.makeUnsafe("req-external");
    context.pendingApprovals.set(requestId, {});
    context.nativeRequestCorrelations.set("85", {
      nativeRequestId: "85",
      requestId,
      method: "applyPatchApproval",
      requestKind: "file-change",
      responseChannel: "approval",
      itemId: "patch-call-1",
      resolvedLocally: false,
    });
    const events: Array<Record<string, unknown>> = [];
    manager.on("event", (event) => events.push(event as unknown as Record<string, unknown>));

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "serverRequest/resolved",
      params: { threadId: "thread_1", requestId: 85 },
    });

    expect(context.pendingApprovals.size).toBe(0);
    expect(context.nativeRequestCorrelations.size).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: "serverRequest/resolved",
      requestId: "req-external",
      requestKind: "file-change",
      itemId: "patch-call-1",
      payload: {
        request: { method: "applyPatchApproval", kind: "file-change" },
        resolutionSource: "server",
      },
    });
  });

  it("suppresses the server acknowledgement after a local resolution", () => {
    const manager = new CodexAppServerManager();
    const context = requestContext();
    const requestId = ApprovalRequestId.makeUnsafe("req-local");
    context.nativeRequestCorrelations.set("86", {
      nativeRequestId: "86",
      requestId,
      method: "execCommandApproval",
      requestKind: "command",
      responseChannel: "approval",
      resolvedLocally: true,
    });
    const events: unknown[] = [];
    manager.on("event", (event) => events.push(event));

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "serverRequest/resolved",
      params: { threadId: "thread_1", requestId: 86 },
    });

    expect(events).toEqual([]);
    expect(context.nativeRequestCorrelations.size).toBe(0);
  });

  it("suppresses uncorrelated late server acknowledgements", () => {
    const manager = new CodexAppServerManager();
    const context = requestContext();
    const events: unknown[] = [];
    manager.on("event", (event) => events.push(event));

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "serverRequest/resolved",
      params: { threadId: "thread_1", requestId: 999 },
    });

    expect(events).toEqual([]);
  });
});

describe("respondToUserInput", () => {
  it("serializes canonical answers to Codex native answer objects", async () => {
    const { manager, context, requireSession, writeMessage, emitEvent } =
      createPendingUserInputHarness();

    await manager.respondToUserInput(
      asThreadId("thread_1"),
      ApprovalRequestId.makeUnsafe("req-user-input-1"),
      {
        scope: "All request methods",
        compat: "Keep current envelope",
      },
    );

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      result: {
        answers: {
          scope: { answers: ["All request methods"] },
          compat: { answers: ["Keep current envelope"] },
        },
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/tool/requestUserInput/answered",
        payload: {
          requestId: "req-user-input-1",
          answers: {
            scope: { answers: ["All request methods"] },
            compat: { answers: ["Keep current envelope"] },
          },
        },
      }),
    );
  });

  it("preserves explicit empty multi-select answers", async () => {
    const { manager, context, requireSession, writeMessage, emitEvent } =
      createPendingUserInputHarness();

    await manager.respondToUserInput(
      asThreadId("thread_1"),
      ApprovalRequestId.makeUnsafe("req-user-input-1"),
      {
        scope: [],
      },
    );

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      result: {
        answers: {
          scope: { answers: [] },
        },
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/tool/requestUserInput/answered",
        payload: {
          requestId: "req-user-input-1",
          answers: {
            scope: { answers: [] },
          },
        },
      }),
    );
  });

  it("retains user-input state when the JSON-RPC response write fails", async () => {
    const { manager, context, writeMessage, emitEvent } = createPendingUserInputHarness();
    const requestId = ApprovalRequestId.makeUnsafe("req-user-input-1");
    writeMessage.mockRejectedValueOnce(new Error("stdin disconnected"));

    await expect(
      manager.respondToUserInput(asThreadId("thread_1"), requestId, { scope: "All" }),
    ).rejects.toThrow("stdin disconnected");

    expect(context.pendingUserInputs.has(requestId)).toBe(true);
    expect(
      (
        context as typeof context & {
          nativeRequestCorrelations: Map<string, { resolvedLocally: boolean }>;
        }
      ).nativeRequestCorrelations.get("42")?.resolvedLocally,
    ).toBe(false);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("tracks file-read approval requests with the correct method", () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        sessionId: "sess_1",
        provider: "codex",
        status: "ready",
        threadId: asThreadId("thread_1"),
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
    };
    type ApprovalRequestContext = {
      session: typeof context.session;
      pendingApprovals: typeof context.pendingApprovals;
      pendingUserInputs: typeof context.pendingUserInputs;
    };

    (
      manager as unknown as {
        handleServerRequest: (
          context: ApprovalRequestContext,
          request: Record<string, unknown>,
        ) => void;
      }
    ).handleServerRequest(context, {
      jsonrpc: "2.0",
      id: 42,
      method: "item/fileRead/requestApproval",
      params: {},
    });

    const request = Array.from(context.pendingApprovals.values())[0];
    expect(request?.requestKind).toBe("file-read");
    expect(request?.method).toBe("item/fileRead/requestApproval");
    expect(request?.responseKind).toBe("decision");
  });

  it("tracks permission approval requests with requested permissions", () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        sessionId: "sess_1",
        provider: "codex",
        status: "ready",
        threadId: asThreadId("thread_1"),
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
    };
    type ApprovalRequestContext = {
      session: typeof context.session;
      pendingApprovals: typeof context.pendingApprovals;
      pendingUserInputs: typeof context.pendingUserInputs;
    };

    (
      manager as unknown as {
        handleServerRequest: (
          context: ApprovalRequestContext,
          request: Record<string, unknown>,
        ) => void;
      }
    ).handleServerRequest(context, {
      jsonrpc: "2.0",
      id: 44,
      method: "item/permissions/requestApproval",
      params: {
        permissions: {
          network: true,
        },
      },
    });

    const request = Array.from(context.pendingApprovals.values())[0];
    expect(request?.requestKind).toBe("permission");
    expect(request?.method).toBe("item/permissions/requestApproval");
    expect(request?.responseKind).toBe("permissions");
    expect(request?.requestedPermissions).toEqual({ network: true });
  });

  it("drops malformed permission profiles at ingress", () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        sessionId: "sess_1",
        provider: "codex",
        status: "ready",
        threadId: asThreadId("thread_1"),
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
    };
    type ApprovalRequestContext = {
      session: typeof context.session;
      pendingApprovals: typeof context.pendingApprovals;
      pendingUserInputs: typeof context.pendingUserInputs;
    };

    (
      manager as unknown as {
        handleServerRequest: (
          context: ApprovalRequestContext,
          request: Record<string, unknown>,
        ) => void;
      }
    ).handleServerRequest(context, {
      jsonrpc: "2.0",
      id: 45,
      method: "item/permissions/requestApproval",
      params: {
        permissions: ["network"],
      },
    });

    const request = Array.from(context.pendingApprovals.values())[0];
    expect(request?.requestKind).toBe("permission");
    expect(request?.requestedPermissions).toBeUndefined();
  });
});

describe.skipIf(!process.env.CODEX_BINARY_PATH)("startSession live Codex resume", () => {
  it("keeps prior thread history when resuming with a changed runtime mode", async () => {
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "codex-live-resume-"));
    writeFileSync(path.join(workspaceDir, "README.md"), "hello\n", "utf8");

    const manager = new CodexAppServerManager();

    try {
      const firstSession = await manager.startSession({
        threadId: asThreadId("thread-live"),
        provider: "codex",
        cwd: workspaceDir,
        runtimeMode: "full-access",
        providerOptions: {
          codex: {
            ...(process.env.CODEX_BINARY_PATH ? { binaryPath: process.env.CODEX_BINARY_PATH } : {}),
            ...(process.env.CODEX_HOME_PATH ? { homePath: process.env.CODEX_HOME_PATH } : {}),
          },
        },
      });

      const firstTurn = await manager.sendTurn({
        threadId: firstSession.threadId,
        input: `Reply with exactly the word ALPHA ${randomUUID()}`,
      });

      expect(firstTurn.threadId).toBe(firstSession.threadId);

      await vi.waitFor(
        async () => {
          const snapshot = await manager.readThread(firstSession.threadId);
          expect(snapshot.turns.length).toBeGreaterThan(0);
        },
        { timeout: 120_000, interval: 1_000 },
      );

      const firstSnapshot = await manager.readThread(firstSession.threadId);
      const originalThreadId = firstSnapshot.threadId;
      const originalTurnCount = firstSnapshot.turns.length;

      manager.stopSession(firstSession.threadId);

      const resumedSession = await manager.startSession({
        threadId: firstSession.threadId,
        provider: "codex",
        cwd: workspaceDir,
        runtimeMode: "approval-required",
        resumeCursor: firstSession.resumeCursor,
        providerOptions: {
          codex: {
            ...(process.env.CODEX_BINARY_PATH ? { binaryPath: process.env.CODEX_BINARY_PATH } : {}),
            ...(process.env.CODEX_HOME_PATH ? { homePath: process.env.CODEX_HOME_PATH } : {}),
          },
        },
      });

      expect(resumedSession.threadId).toBe(originalThreadId);

      const resumedSnapshotBeforeTurn = await manager.readThread(resumedSession.threadId);
      expect(resumedSnapshotBeforeTurn.threadId).toBe(originalThreadId);
      expect(resumedSnapshotBeforeTurn.turns.length).toBeGreaterThanOrEqual(originalTurnCount);

      await manager.sendTurn({
        threadId: resumedSession.threadId,
        input: `Reply with exactly the word BETA ${randomUUID()}`,
      });

      await vi.waitFor(
        async () => {
          const snapshot = await manager.readThread(resumedSession.threadId);
          expect(snapshot.turns.length).toBeGreaterThan(originalTurnCount);
        },
        { timeout: 120_000, interval: 1_000 },
      );
    } finally {
      manager.stopAll();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }, 180_000);
});
