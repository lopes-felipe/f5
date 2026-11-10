import { describe, expect, it, vi } from "vitest";

import {
  DesktopNotificationRegistry,
  parseDesktopNotificationInput,
  type DesktopNotificationLike,
} from "./desktopNotifications";

class FakeNotification implements DesktopNotificationLike {
  readonly listeners = new Map<string, Array<() => void>>();
  shown = false;
  closed = false;
  constructor(readonly input: { title: string; body?: string; silent?: boolean; icon?: string }) {}
  on(event: string, listener: () => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string) {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
  show() {
    this.shown = true;
  }
  close() {
    this.closed = true;
  }
}

function setup(
  options: {
    maxEntries?: number;
    openProfile?: (profileId: string) => Promise<unknown>;
    selectWindow?: (profileId: string) => number | null;
  } = {},
) {
  const created: FakeNotification[] = [];
  const calls: string[] = [];
  let now = 1_000;
  const registry = new DesktopNotificationRegistry({
    create: (input) => {
      const notice = new FakeNotification(input);
      created.push(notice);
      return notice;
    },
    openProfile:
      options.openProfile ??
      (async (profileId: string) => {
        calls.push(`open:${profileId}`);
        return true;
      }),
    selectWindow: options.selectWindow ?? (() => 7),
    announce: (profileId, webContentsId) => {
      calls.push(`announce:${profileId}:${webContentsId}`);
    },
    now: () => now,
    ...(options.maxEntries ? { maxEntries: options.maxEntries } : {}),
  });
  return {
    registry,
    created,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const threadTarget = { kind: "thread", threadId: "thread-1" } as const;

describe("DesktopNotificationRegistry", () => {
  it("keeps holding a notification after macOS reports it closed", async () => {
    const { registry, created, calls } = setup();
    registry.show("p1", { id: "n1", title: "Completed", target: threadTarget });
    created[0]!.emit("close");
    expect(registry.size).toBe(1);

    created[0]!.emit("click");
    await vi.waitFor(() => expect(calls).toEqual(["open:p1", "announce:p1:7"]));
    expect(registry.size).toBe(0);
    expect(registry.take("p1", 7)).toEqual([{ id: "n1", target: threadTarget }]);
    expect(registry.take("p1", 7)).toEqual([]);
  });

  it("gives the activation only to the window that was brought forward", async () => {
    const { registry, created, calls } = setup({ selectWindow: () => 7 });
    registry.show("p1", { id: "n1", title: "Completed", target: threadTarget });
    created[0]!.emit("click");
    await vi.waitFor(() => expect(calls).toContain("announce:p1:7"));
    // A background pop-out of the same profile asks first and gets nothing.
    expect(registry.take("p1", 8)).toEqual([]);
    expect(registry.take("p1", 7)).toEqual([{ id: "n1", target: threadTarget }]);
  });

  it("lets any window of the profile take it when no window could be chosen", async () => {
    const { registry, created, calls } = setup({ selectWindow: () => null });
    registry.show("p1", { id: "n1", title: "Completed", target: threadTarget });
    created[0]!.emit("click");
    await vi.waitFor(() => expect(calls).toContain("announce:p1:null"));
    expect(registry.take("p1", 3)).toEqual([{ id: "n1", target: threadTarget }]);
  });

  it("queues nothing when the profile can't be opened", async () => {
    const failing = setup({ openProfile: async () => Promise.reject(new Error("not ready")) });
    failing.registry.show("p1", { id: "n1", title: "Completed", target: threadTarget });
    failing.created[0]!.emit("click");
    const quitting = setup({ openProfile: async () => false });
    quitting.registry.show("p1", { id: "n2", title: "Completed", target: threadTarget });
    quitting.created[0]!.emit("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failing.registry.take("p1", 7)).toEqual([]);
    expect(quitting.registry.take("p1", 7)).toEqual([]);
    expect(failing.calls).toEqual([]);
  });

  it("drops an activation nobody took within a minute", async () => {
    const { registry, created, calls, advance } = setup();
    registry.show("p1", { id: "n1", title: "Completed", target: threadTarget });
    created[0]!.emit("click");
    await vi.waitFor(() => expect(calls).toContain("announce:p1:7"));
    advance(60_001);
    expect(registry.take("p1", 7)).toEqual([]);
  });

  it("replaces an entry with the same tag and closes the old banner", () => {
    const { registry, created } = setup();
    registry.show("p1", { id: "a", tag: "t", title: "One", target: threadTarget });
    registry.show("p1", { id: "b", tag: "t", title: "Two", target: threadTarget });
    expect(created[0]!.closed).toBe(true);
    expect(created[1]!.shown).toBe(true);
    expect(registry.size).toBe(1);
  });

  it("keeps tags separate per profile", () => {
    const { registry } = setup();
    registry.show("p1", { id: "a", tag: "t", title: "One", target: threadTarget });
    registry.show("p2", { id: "b", tag: "t", title: "Two", target: threadTarget });
    expect(registry.size).toBe(2);
  });

  it("evicts the oldest entry of the same profile without closing it", async () => {
    const { registry, created, calls } = setup({ maxEntries: 200 });
    registry.show("p2", { id: "other", title: "Other", target: threadTarget });
    for (let index = 0; index < 201; index += 1)
      registry.show("p1", { id: `n${index}`, title: `N${index}`, target: { kind: "none" } });
    expect(registry.size).toBe(201);
    expect(created[1]!.closed).toBe(false);
    // The other profile's notification is still held, so its click still opens its target.
    created[0]!.emit("click");
    await vi.waitFor(() => expect(calls).toContain("announce:p2:7"));
    expect(registry.take("p2", 7)).toEqual([{ id: "other", target: threadTarget }]);
  });

  it("passes the icon through to the notification", () => {
    const { registry, created } = setup();
    registry.show("p1", {
      id: "a",
      title: "One",
      icon: "data:image/png;base64,AAAA",
      target: threadTarget,
    });
    expect(created[0]!.input).toMatchObject({ icon: "data:image/png;base64,AAAA" });
  });
});

describe("parseDesktopNotificationInput", () => {
  it("accepts each target kind", () => {
    for (const target of [
      threadTarget,
      { kind: "prHub" },
      { kind: "prHub", prKey: "o/r#1" },
      { kind: "scheduled", taskId: "task" },
      { kind: "upstream", projectId: "project" },
      { kind: "update" },
      { kind: "none" },
    ])
      expect(parseDesktopNotificationInput({ id: "n", title: "T", target })?.target).toEqual(
        target,
      );
  });

  it("rejects unknown targets and missing fields", () => {
    expect(parseDesktopNotificationInput({ id: "n", title: "T", target: { kind: "url" } })).toBe(
      null,
    );
    expect(parseDesktopNotificationInput({ id: "n", title: "T", target: { kind: "thread" } })).toBe(
      null,
    );
    expect(parseDesktopNotificationInput({ id: "n", title: " ", target: threadTarget })).toBe(null);
    expect(parseDesktopNotificationInput(null)).toBe(null);
  });

  it("caps the title and body", () => {
    const parsed = parseDesktopNotificationInput({
      id: "n",
      title: "t".repeat(400),
      body: "b".repeat(2000),
      target: threadTarget,
    });
    expect(parsed?.title).toHaveLength(256);
    expect(parsed?.body).toHaveLength(1024);
  });
});

describe("notification icons and tags", () => {
  it("keeps small PNG icons and drops anything else", () => {
    const base = { id: "n", title: "T", target: threadTarget };
    expect(
      parseDesktopNotificationInput({ ...base, icon: "data:image/png;base64,AAAA" })?.icon,
    ).toBe("data:image/png;base64,AAAA");
    expect(
      parseDesktopNotificationInput({ ...base, icon: "data:image/svg+xml,<svg/>" }),
    ).not.toHaveProperty("icon");
    expect(
      parseDesktopNotificationInput({
        ...base,
        icon: `data:image/png;base64,${"A".repeat(70_000)}`,
      }),
    ).not.toHaveProperty("icon");
  });
});
