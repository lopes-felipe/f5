import { expect, it } from "vitest";
import type { OrchestrationReadModel } from "@t3tools/contracts";
import { busyThreadIds, desktopBusyThreadCount, isBusySession } from "./sessionBusy";

it("counts busy sessions, excludes deleted threads, and deduplicates ids", () => {
  const threads = [
    { id: "starting", deletedAt: null, session: { status: "starting", activeTurnId: null } },
    { id: "running", deletedAt: null, session: { status: "running", activeTurnId: null } },
    { id: "turn", deletedAt: null, session: { status: "ready", activeTurnId: "turn" } },
    { id: "deleted", deletedAt: "now", session: { status: "running", activeTurnId: null } },
    { id: "idle", deletedAt: null, session: { status: "idle", activeTurnId: null } },
    { id: "none", deletedAt: null, session: null },
  ];
  const model = { threads } as unknown as OrchestrationReadModel;
  expect([...busyThreadIds(model)]).toEqual(["starting", "running", "turn"]);
  expect(desktopBusyThreadCount(model, ["turn", "idle", "deleted", "missing"])).toBe(4);
  for (const status of ["ready", "idle", "error"])
    expect(isBusySession({ status, activeTurnId: null })).toBe(false);
});
