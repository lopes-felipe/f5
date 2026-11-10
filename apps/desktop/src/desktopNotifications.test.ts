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
  constructor(readonly input: { title: string; body?: string; silent?: boolean }) {}
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

function setup(maxEntries?: number) {
  const created: FakeNotification[] = [];
  const calls: string[] = [];
  const registry = new DesktopNotificationRegistry({
    create: (input) => {
      const notice = new FakeNotification(input);
      created.push(notice);
      return notice;
    },
    openProfile: vi.fn(async (profileId: string) => {
      calls.push(`open:${profileId}`);
    }),
    announce: (profileId) => {
      calls.push(`announce:${profileId}`);
    },
    ...(maxEntries ? { maxEntries } : {}),
  });
  return { registry, created, calls };
}

const threadTarget = { kind: "thread", threadId: "thread-1" } as const;

describe("DesktopNotificationRegistry", () => {
  it("keeps holding a notification after macOS reports it closed", async () => {
    const { registry, created, calls } = setup();
    registry.show("p1", { id: "n1", title: "Completed", target: threadTarget });
    created[0]!.emit("close");
    expect(registry.size).toBe(1);

    created[0]!.emit("click");
    await vi.waitFor(() => expect(calls).toEqual(["open:p1", "announce:p1"]));
    expect(registry.take("p1")).toEqual([{ id: "n1", target: threadTarget }]);
  });

  it("queues the activation before opening the profile and removes the entry", async () => {
    const { registry, created } = setup();
    let queuedAtOpen: unknown;
    const opening = new DesktopNotificationRegistry({
      create: (input) => {
        const notice = new FakeNotification(input);
        created.push(notice);
        return notice;
      },
      openProfile: async (profileId) => {
        queuedAtOpen = opening.take(profileId);
      },
      announce: () => undefined,
    });
    opening.show("p1", { id: "n1", title: "Needs input", target: threadTarget });
    created.at(-1)!.emit("click");
    await vi.waitFor(() => expect(queuedAtOpen).toEqual([{ id: "n1", target: threadTarget }]));
    expect(opening.size).toBe(0);
    expect(registry.take("p1")).toEqual([]);
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

  it("evicts the oldest entry without closing it", () => {
    const { registry, created } = setup(200);
    for (let index = 0; index < 201; index += 1)
      registry.show("p1", { id: `n${index}`, title: `N${index}`, target: { kind: "none" } });
    expect(registry.size).toBe(200);
    expect(created[0]!.closed).toBe(false);
  });

  it("closes an entry on request", () => {
    const { registry, created } = setup();
    registry.show("p1", { id: "a", tag: "t", title: "One", target: threadTarget });
    registry.close("p1", "t");
    expect(created[0]!.closed).toBe(true);
    expect(registry.size).toBe(0);
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
