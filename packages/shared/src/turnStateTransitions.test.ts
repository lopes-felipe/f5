import {
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
} from "@t3tools/contracts";
import { expect, it } from "vitest";
import { projectLatestTurnSession } from "./turnStateTransitions";

const turn: OrchestrationLatestTurn = {
  turnId: TurnId.make("turn"),
  state: "running",
  requestedAt: "2026-10-19T00:00:00Z",
  startedAt: null,
  completedAt: null,
  assistantMessageId: null,
};
const session = (status: OrchestrationSession["status"]): OrchestrationSession => ({
  threadId: ThreadId.make("thread"),
  status,
  providerName: "codex",
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: null,
  usageLimit: null,
  updatedAt: "2026-10-19T00:00:01Z",
});
it.each(["ready", "error", "stopped"] as const)(
  "settles only the matching running turn on %s",
  (status) => {
    expect(
      projectLatestTurnSession(turn, {
        session: session(status),
        settledTurnId: TurnId.make("old"),
      }),
    ).toBe(turn);
    expect(
      projectLatestTurnSession(turn, { session: session(status), settledTurnId: turn.turnId }),
    ).toMatchObject({
      state: status === "ready" ? "completed" : status === "error" ? "error" : "interrupted",
      startedAt: session(status).updatedAt,
      completedAt: session(status).updatedAt,
    });
  },
);
it("repairs an errored turn only with a current explicit successful settlement and preserves its start", () => {
  const previous = { ...turn, state: "error", completedAt: "2026-10-19T00:00:01Z" } as const;
  expect(projectLatestTurnSession(previous, { session: session("ready") })).toBe(previous);
  expect(
    projectLatestTurnSession(previous, {
      session: { ...session("ready"), updatedAt: "2026-10-19T00:00:00Z" },
      settledTurnId: turn.turnId,
    }),
  ).toBe(previous);
  expect(
    projectLatestTurnSession(previous, { session: session("ready"), settledTurnId: turn.turnId }),
  ).toMatchObject({ state: "completed", startedAt: null });
});
it("does not complete a turn for a non-terminal session update", () => {
  for (const status of ["starting", "idle", "interrupted"] as const)
    expect(projectLatestTurnSession(turn, { session: session(status) })).toBe(turn);
});
it("starts a replacement turn with a fresh lifecycle and keeps the same turn's request time", () => {
  const running = { ...session("running"), activeTurnId: turn.turnId };
  expect(projectLatestTurnSession(turn, { session: running })).toMatchObject({
    turnId: turn.turnId,
    requestedAt: turn.requestedAt,
    completedAt: null,
  });
  expect(
    projectLatestTurnSession(
      { ...turn, state: "error", assistantMessageId: null },
      { session: { ...running, activeTurnId: TurnId.make("replacement") } },
    ),
  ).toMatchObject({
    turnId: "replacement",
    requestedAt: running.updatedAt,
    state: "running",
    completedAt: null,
  });
});
