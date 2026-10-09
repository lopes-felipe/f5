import { describe, expect, it, vi } from "vitest";
import type { ComputerAccessRequested, ComputerApp } from "@t3tools/contracts";
import { ComputerAccessService, type RememberedComputerGrant } from "./ComputerAccessService";
const app: ComputerApp = {
  appId: "com.apple.Terminal",
  name: "Terminal",
  running: true,
  frontmost: false,
  tier: "click",
};
async function harness(
  remembered: ReadonlyArray<RememberedComputerGrant> = [],
  platform: "darwin" | "win32" = "darwin",
) {
  const requests: ComputerAccessRequested[] = [];
  const save = vi.fn(async () => {});
  const changed = vi.fn();
  const service = new ComputerAccessService({
    platform,
    backendIncarnation: "backend",
    storage: { load: async () => remembered, save },
    request: (request) => requests.push(request),
    settled: vi.fn(),
    changed,
    timeoutMs: 50,
  });
  await service.initialize();
  service.bind("t", "p", "s");
  return { service, requests, save, changed };
}
describe("server-owned computer grants", () => {
  it("preserves native tier ceilings and normalizes remembered packaged identities", async () => {
    const rawId = "Vendor.PasswordManager_abcd!App";
    const h = await harness(
      [{ appId: rawId, projectId: "p", tier: "view", allowTyping: true }],
      "win32",
    );
    try {
      expect(h.service.grants("t")).toEqual([
        { appId: rawId.toLowerCase(), tier: "view", allowTyping: false },
      ]);
      expect(() => h.service.require("t", rawId.toLowerCase(), "click")).toThrow();
      h.service.revoke("t", rawId);
      expect(h.service.grants("t")).toEqual([]);
      await h.service.forgetRemembered("p", rawId);
      expect(h.service.listRemembered("p")).toEqual([]);
    } finally {
      h.service.close();
    }
  });
  it("keeps a host-reported view app read only when its AUMID is otherwise unclassified", async () => {
    const h = await harness([], "win32");
    const protectedApp = { ...app, appId: "vendor.passwords!app", tier: "view" as const };
    try {
      const pending = h.service.requestAccess("t", "turn", [protectedApp], "View");
      expect(h.requests[0]?.apps[0]?.tier).toBe("view");
      await h.service.answerFromHost({
        requestId: h.requests[0]!.requestId,
        backendIncarnation: "backend",
        decisions: [{ appId: protectedApp.appId, allow: true, allowTyping: true, remember: true }],
      });
      await pending;
      expect(h.service.grants("t")).toEqual([
        { appId: protectedApp.appId, tier: "view", allowTyping: false },
      ]);
      expect(() => h.service.require("t", protectedApp.appId, "type")).toThrow();
    } finally {
      h.service.close();
    }
  });
  it("bumps every session in the project when remembered access changes", async () => {
    const { service, requests, changed } = await harness();
    service.bind("other", "p", "other-session");
    const old = service.version("other");
    const pending = service.requestAccess("t", "turn", [app], "Edit");
    await service.answerFromHost({
      requestId: requests[0]!.requestId,
      backendIncarnation: "backend",
      decisions: [{ appId: app.appId, allow: true, allowTyping: false, remember: true }],
    });
    await pending;
    expect(service.grants("other")).toHaveLength(1);
    expect(service.version("other")).toBeGreaterThan(old);
    expect(changed).toHaveBeenCalledWith("other");
    service.close();
  });
  it("rolls back a remember write when the session ends during storage", async () => {
    const requests: ComputerAccessRequested[] = [];
    let releaseWrite: () => void = () => {};
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseWrite = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const service = new ComputerAccessService({
      platform: "darwin",
      backendIncarnation: "backend",
      storage: { load: async () => [], save },
      request: (request) => requests.push(request),
      settled: vi.fn(),
      changed: vi.fn(),
      timeoutMs: 1000,
    });
    await service.initialize();
    service.bind("t", "p", "s");
    const pending = service.requestAccess("t", "turn", [app], "Edit");
    const answer = service.answerFromHost({
      requestId: requests[0]!.requestId,
      backendIncarnation: "backend",
      decisions: [{ appId: app.appId, allow: true, allowTyping: true, remember: true }],
    });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    service.clearSession("t", "s");
    releaseWrite();
    await answer;
    expect(await pending).toBeNull();
    expect(save).toHaveBeenLastCalledWith([]);
    expect(service.listRemembered("p")).toEqual([]);
    service.close();
  });
  it("answers only from the owning backend and ignores unrequested apps", async () => {
    const { service, requests } = await harness();
    const pending = service.requestAccess("t", "turn", [app], "Edit");
    const id = requests[0]!.requestId;
    await expect(
      service.answerFromHost({ requestId: id, backendIncarnation: "old", decisions: [] }),
    ).rejects.toThrow("expired");
    await service.answerFromHost({
      requestId: id,
      backendIncarnation: "backend",
      decisions: [
        { appId: app.appId, allow: true, allowTyping: false, remember: false },
        { appId: "com.apple.Safari", allow: true, allowTyping: true, remember: true },
      ],
    });
    await pending;
    expect(service.grants("t")).toEqual([{ appId: app.appId, tier: "click", allowTyping: false }]);
    expect(() => service.require("t", app.appId, "type")).toThrow();
    service.close();
  });
  it("session deny overrides remembered access, restart drops only session grants", async () => {
    const { service } = await harness([
      { projectId: "p", appId: app.appId, tier: "click", allowTyping: true },
    ]);
    expect(service.grants("t")).toHaveLength(1);
    service.revoke("t", app.appId);
    expect(service.grants("t")).toHaveLength(0);
    service.bind("t", "p", "new");
    expect(service.grants("t")).toHaveLength(1);
    service.clearSession("t", "s");
    expect(service.grants("t")).toHaveLength(1);
    service.close();
  });
  it("never allows blocked apps or promotes view apps through allowTyping", async () => {
    const { service, requests } = await harness();
    await service.requestAccess(
      "t",
      "turn",
      [{ ...app, appId: "com.apple.systempreferences", tier: "blocked" }],
      "No",
    );
    expect(requests).toHaveLength(0);
    const pending = service.requestAccess(
      "t",
      "turn",
      [{ ...app, appId: "com.1password.1password", tier: "view" }],
      "View",
    );
    await service.answerFromHost({
      requestId: requests[0]!.requestId,
      backendIncarnation: "backend",
      decisions: [
        { appId: "com.1password.1password", allow: true, allowTyping: true, remember: true },
      ],
    });
    await pending;
    expect(service.grants("t")[0]?.allowTyping).toBe(false);
    expect(() => service.require("t", "com.1password.1password", "click")).toThrow();
    service.close();
  });
  it("expires as deny and does not prompt again within the turn", async () => {
    vi.useFakeTimers();
    try {
      const { service, requests } = await harness();
      const first = service.requestAccess("t", "turn", [app], "Edit");
      await vi.advanceTimersByTimeAsync(51);
      expect(await first).toBeNull();
      expect(service.grants("t")).toHaveLength(0);
      await service.requestAccess("t", "turn", [app], "Again");
      expect(requests).toHaveLength(1);
      await expect(
        service.answerFromHost({
          requestId: requests[0]!.requestId,
          backendIncarnation: "backend",
          decisions: [],
        }),
      ).rejects.toThrow("expired");
      service.close();
    } finally {
      vi.useRealTimers();
    }
  });
  it("serializes remember and forget writes and pushes new grant versions", async () => {
    const { service, requests, save, changed } = await harness();
    const pending = service.requestAccess("t", "turn", [app], "Edit");
    await service.answerFromHost({
      requestId: requests[0]!.requestId,
      backendIncarnation: "backend",
      decisions: [{ appId: app.appId, allow: true, allowTyping: true, remember: true }],
    });
    await pending;
    expect(save).toHaveBeenCalledTimes(1);
    const version = service.version("t");
    await service.forgetRemembered("p", app.appId);
    expect(service.listRemembered("p")).toEqual([]);
    expect(service.version("t")).toBeGreaterThan(version);
    expect(changed).toHaveBeenCalled();
    service.close();
  });
});
