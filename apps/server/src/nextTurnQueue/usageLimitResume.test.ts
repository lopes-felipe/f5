import { describe, expect, it } from "vitest";
import { usageLimitKey, normalizeTarget, MAX_HORIZON_MS } from "./usageLimitResume.ts";

describe("usage-limit recovery identity and dates", () => {
  it("normalizes dates to UTC and rejects nonfinite timestamps", () => {
    expect(normalizeTarget(Date.parse("2026-10-01T10:00:00+02:00"))).toBe(
      "2026-10-01T08:00:00.000Z",
    );
    expect(normalizeTarget(NaN)).toBeNull();
    expect(normalizeTarget(Infinity)).toBeNull();
    expect(normalizeTarget(8.64e15)).toBeNull();
    expect(MAX_HORIZON_MS).toBe(8 * 24 * 60 * 60_000);
  });
  it("uses turn identity across runtime-error and terminal reports", () => {
    const limit = {
      providerInstanceId: "codex",
      turnId: "turn",
      deliveryId: null,
      windows: [],
      resetsAt: null,
      resetSource: null,
      evidence: "typed",
    };
    expect(usageLimitKey({ usageLimit: limit } as never)).toBe("instance:codex:turn:turn");
    expect(
      usageLimitKey({ usageLimit: { ...limit, turnId: null, deliveryId: "delivery" } } as never),
    ).toBe("instance:codex:delivery:delivery");
    expect(usageLimitKey({ usageLimit: { ...limit, turnId: null } } as never)).toBeNull();
    expect(usageLimitKey(null)).toBeNull();
  });
});

import { Effect } from "effect";
import { vi } from "vitest";
import { ThreadId } from "@t3tools/contracts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { NextTurnQueueStore } from "./Services/NextTurnQueueStore.ts";
import { scheduleUsageLimitResumeFor } from "./usageLimitResume.ts";

describe("recovery target calculation", () => {
  const threadId = ThreadId.makeUnsafe("limited-thread");
  const now = Date.parse("2026-10-01T10:00:00.000Z");
  async function schedule(
    overrides: Record<string, unknown> = {},
    input: Record<string, unknown> = {},
    ledger: unknown = null,
  ) {
    type Submission = {
      notBefore: string;
      command: { expectedTurnId?: string; message: { text: string }; presentation: string };
    };
    const captured: { submitted: Submission | null } = { submitted: null };
    const session = {
      status: "error",
      activeTurnId: null,
      usageLimit: {
        providerInstanceId: "codex",
        turnId: "turn",
        deliveryId: null,
        resetsAt: new Date(now + 2000).toISOString(),
        windows: [],
        evidence: "typed",
        resetSource: "provider",
      },
    };
    const thread = {
      id: threadId,
      projectId: "project",
      deletedAt: null,
      archivedAt: null,
      pendingUserInputs: [],
      session,
      model: "gpt-5",
      runtimeMode: "full-access",
      interactionMode: "default",
      ...overrides,
    };
    const result = await Effect.runPromise(
      scheduleUsageLimitResumeFor({ threadId, source: "manual", ...input } as never).pipe(
        Effect.provideService(OrchestrationEngineService, {
          getReadModel: () => Effect.succeed({ threads: [thread] }),
        } as never),
        Effect.provideService(NextTurnQueueStore, {
          getUsageResumeLedger: () => Effect.succeed(ledger),
          scheduleUsageLimitResume: (submission: Submission) =>
            Effect.sync(() => {
              captured.submitted = submission;
              return "created";
            }),
        } as never),
      ),
    );
    return { result, submitted: captured.submitted };
  }
  it("adds the safety buffer without turning the command into a steer", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const { result, submitted } = await schedule();
      expect(result.kind).toBe("created");
      expect(submitted?.notBefore).toBe("2026-10-01T10:01:02.000Z");
      expect(submitted?.command.message.text).toBe("continue");
      expect(submitted?.command.presentation).toBe("continuation");
      expect(submitted?.command.expectedTurnId).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });
  it("normalizes manually picked offsets and rejects unknown or distant resets", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(
        (await schedule({}, { notBefore: "2026-10-01T14:00:00+02:00" })).submitted?.notBefore,
      ).toBe("2026-10-01T12:00:00.000Z");
      expect((await schedule({}, { notBefore: "2026-10-12T00:00:00.000Z" })).result.kind).toBe(
        "ineligible",
      );
      expect(
        (
          await schedule({
            session: {
              usageLimit: {
                providerInstanceId: "codex",
                turnId: "turn",
                deliveryId: null,
                resetsAt: null,
              },
            },
          })
        ).result.kind,
      ).toBe("ineligible");
      expect(
        (
          await schedule({
            session: {
              activeTurnId: "running",
              usageLimit: {
                providerInstanceId: "codex",
                turnId: "turn",
                deliveryId: null,
                resetsAt: "2026-10-02T00:00:00Z",
              },
            },
          })
        ).result.kind,
      ).toBe("transient");
    } finally {
      clock.mockRestore();
    }
  });
  it("never schedules continue for a message rejected before a provider turn started", async () => {
    const { result, submitted } = await schedule({
      session: {
        status: "error",
        activeTurnId: null,
        usageLimit: {
          providerInstanceId: "codex",
          turnId: null,
          deliveryId: "unsent-delivery",
          resetsAt: "2026-10-02T00:00:00.000Z",
          windows: [],
          evidence: "typed",
          resetSource: "provider",
        },
      },
    });
    expect(result.kind).toBe("ineligible");
    expect(submitted).toBeNull();
  });
  it("backs off repeated exhausted windows and rejects stale identities", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const { submitted } = await schedule(
        {},
        {},
        { notBefore: "2026-10-01T10:01:02.000Z", autoCount: 2 },
      );
      expect(submitted?.notBefore).toBe("2026-10-01T10:05:00.000Z");
      expect(
        (await schedule({}, { expectedLimitKey: "instance:codex:turn:other" })).result.kind,
      ).toBe("ineligible");
    } finally {
      clock.mockRestore();
    }
  });
});
