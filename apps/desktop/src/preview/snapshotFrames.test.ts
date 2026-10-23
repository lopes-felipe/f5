import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { capturePreviewSnapshotPage } from "./snapshotScript";

const diagnostics = { consoleEntries: [], networkEntries: [], actionTimeline: [] };
const tree = (id: string, children: ReturnType<typeof leaf>[] = []) => ({
  frame: { id, loaderId: `loader-${id}` },
  childFrames: children,
});
const leaf = (id: string) => ({ frame: { id, loaderId: `loader-${id}` } });

function fixture(outOfProcess = false) {
  const values = new Map<string, string[]>([
    ["main", []],
    ["child", ["cross-frame-credential"]],
    ["grandchild", []],
  ]);
  const frames = ["main", "child", ...(outOfProcess ? ["grandchild"] : [])];
  const sessions = outOfProcess
    ? { main: tree("main", [leaf("child")]), child: tree("child", [leaf("grandchild")]) }
    : { main: tree("main", [leaf("child")]), child: leaf("child") };
  let capture = async () => ({
    visibleText: "Reflected cross-frame-credential",
    consoleEntries: [{ text: "logged cross-frame-credential" }],
  });
  const sendCommand = vi.fn(
    async (
      method: string,
      params: Record<string, unknown> = {},
      session?: string,
    ): Promise<unknown> => {
      if (method === "Page.getFrameTree")
        return { frameTree: session ? sessions.child : sessions.main };
      if (method === "Page.createIsolatedWorld") {
        if (outOfProcess && params.frameId === "child" && !session)
          throw new Error("Frame belongs to another process");
        return { executionContextId: frames.indexOf(String(params.frameId)) + 1 };
      }
      if (method === "Runtime.evaluate")
        return { result: { value: values.get(frames[Number(params.contextId) - 1]!) } };
      if (method === "Target.getTargetInfo")
        return { targetInfo: { type: "iframe", targetId: params.targetId } };
      if (method === "Target.attachToTarget") return { sessionId: "owned-child-session" };
      if (method === "Target.detachFromTarget") return {};
      throw new Error("Unexpected debugger command");
    },
  );
  const guest = Object.assign(new EventEmitter(), {
    mainFrame: {
      framesInSubtree: frames.map((id, index) => ({
        processId: 1,
        frameTreeNodeId: index,
        frameToken: id,
      })),
    },
    debugger: { isAttached: () => true, attach: vi.fn(), sendCommand },
    executeJavaScriptInIsolatedWorld: vi.fn(async () => capture()),
  });
  return {
    guest: guest as unknown as Parameters<typeof capturePreviewSnapshotPage>[0],
    raw: guest,
    values,
    sendCommand,
    setCapture: (next: typeof capture) => {
      capture = next;
    },
  };
}

it.each([false, true])(
  "redacts credentials from child frames and diagnostics (separate process: %s)",
  async (outOfProcess) => {
    const f = fixture(outOfProcess);
    const result = await capturePreviewSnapshotPage(f.guest, diagnostics);
    expect(result.visibleText).toBe("Reflected ••••••••");
    expect(JSON.stringify(result)).not.toContain("cross-frame-credential");
    if (outOfProcess) {
      expect(f.sendCommand).toHaveBeenCalledWith("Target.attachToTarget", {
        targetId: "child",
        flatten: true,
      });
      expect(f.sendCommand).toHaveBeenCalledWith("Target.detachFromTarget", {
        sessionId: "owned-child-session",
      });
    }
  },
);

it("fails closed when a child frame cannot be read in isolation", async () => {
  const f = fixture();
  const original = f.sendCommand.getMockImplementation()!;
  f.sendCommand.mockImplementation(async (method, params, session) => {
    if (method === "Page.createIsolatedWorld" && params?.frameId === "child")
      throw new Error("unreadable frame");
    if (method === "Target.attachToTarget") throw new Error("attachment denied");
    return original(method, params, session);
  });
  await expect(capturePreviewSnapshotPage(f.guest, diagnostics)).rejects.toThrow("snapshot");
  expect(f.raw.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
});

it("keeps credentials observed during a retry masked before the text limit", async () => {
  const f = fixture();
  let count = 0;
  f.setCapture(async () => {
    count++;
    f.values.set("child", ["replacement-credential"]);
    return { visibleText: "x".repeat(19_995) + "cross-frame-credential", consoleEntries: [] };
  });
  const result = await capturePreviewSnapshotPage(f.guest, diagnostics);
  expect(count).toBe(2);
  expect(result.visibleText).toBe("x".repeat(19_995) + "•••••");
});

it("rejects repeated field changes rather than returning a partially redacted snapshot", async () => {
  const f = fixture();
  let count = 0;
  f.setCapture(async () => {
    f.values.set("child", [`changed-${++count}`]);
    return { visibleText: "cross-frame-credential", consoleEntries: [] };
  });
  await expect(capturePreviewSnapshotPage(f.guest, diagnostics)).rejects.toThrow("page changed");
  expect(count).toBe(2);
});

it("bounds the total protected values retained across a retry", async () => {
  const f = fixture();
  f.values.set(
    "child",
    Array.from({ length: 80 }, (_, i) => `old-${i}-${"x".repeat(12_000)}`),
  );
  let captures = 0;
  f.setCapture(async () => {
    captures++;
    f.values.set(
      "child",
      Array.from({ length: 80 }, (_, i) => `new-${i}-${"y".repeat(12_000)}`),
    );
    return { visibleText: "protected", consoleEntries: [] };
  });
  await expect(capturePreviewSnapshotPage(f.guest, diagnostics)).rejects.toThrow("snapshot");
  expect(captures).toBe(1);
});

it("does not attach a page target when a missing child frame id no longer identifies an iframe", async () => {
  const f = fixture(true);
  const original = f.sendCommand.getMockImplementation()!;
  f.sendCommand.mockImplementation(async (method, params, session) => {
    if (method === "Target.getTargetInfo")
      return { targetInfo: { type: "page", targetId: params?.targetId } };
    return original(method, params, session);
  });
  await expect(capturePreviewSnapshotPage(f.guest, diagnostics)).rejects.toThrow("snapshot");
  expect(f.sendCommand.mock.calls.some(([method]) => method === "Target.attachToTarget")).toBe(
    false,
  );
});

it("discovers omitted remote frames only after proving ownership in an inspected DOM", async () => {
  const f = fixture();
  const original = f.sendCommand.getMockImplementation()!;
  f.sendCommand.mockImplementation(async (method, params, session) => {
    if (method === "Page.getFrameTree" && !session) return { frameTree: leaf("main") };
    if (method === "Target.getTargets")
      return {
        targetInfos: [
          { type: "iframe", targetId: "foreign" },
          { type: "iframe", targetId: "child" },
          { type: "page", targetId: "other-page" },
        ],
      };
    if (method === "DOM.getFrameOwner") {
      if (params?.frameId === "child" && !session) return { backendNodeId: 42 };
      throw new Error("Frame does not belong to this target");
    }
    return original(method, params, session);
  });
  expect((await capturePreviewSnapshotPage(f.guest, diagnostics)).visibleText).toBe(
    "Reflected ••••••••",
  );
  const attachments = f.sendCommand.mock.calls.filter(
    ([method]) => method === "Target.attachToTarget",
  );
  expect(attachments).toEqual([["Target.attachToTarget", { targetId: "child", flatten: true }]]);
});

it("rejects a new document even when the native frame identity stays the same", async () => {
  const f = fixture();
  const original = f.sendCommand.getMockImplementation()!;
  let generation = 0;
  f.sendCommand.mockImplementation(async (method, params, session) => {
    if (method === "Page.getFrameTree" && !session)
      return {
        frameTree: {
          ...tree("main", [leaf("child")]),
          frame: { id: "main", loaderId: `document-${generation}` },
        },
      };
    return original(method, params, session);
  });
  f.setCapture(async () => {
    generation++;
    return { visibleText: "cross-frame-credential", consoleEntries: [] };
  });
  await expect(capturePreviewSnapshotPage(f.guest, diagnostics)).rejects.toThrow("page changed");
});

it("rejects frames inserted between the protected-field reads", async () => {
  const f = fixture();
  f.setCapture(async () => {
    f.raw.mainFrame.framesInSubtree.push({ processId: 2, frameTreeNodeId: 99, frameToken: "new" });
    return { visibleText: "cross-frame-credential", consoleEntries: [] };
  });
  await expect(capturePreviewSnapshotPage(f.guest, diagnostics)).rejects.toThrow("page changed");
});

it("bounds hung renderer requests instead of accumulating repeated snapshots", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const original = f.sendCommand.getMockImplementation()!;
    let answer!: (value: unknown) => void;
    f.sendCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const failed = expect(capturePreviewSnapshotPage(f.guest, diagnostics)).rejects.toThrow(
      "timed out",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    await expect(capturePreviewSnapshotPage(f.guest, diagnostics)).rejects.toThrow(
      "still finishing",
    );
    expect(f.sendCommand).toHaveBeenCalledTimes(1);
    answer(await original("Page.getFrameTree"));
    await vi.advanceTimersByTimeAsync(0);
    expect((await capturePreviewSnapshotPage(f.guest, diagnostics)).visibleText).toBe(
      "Reflected ••••••••",
    );
  } finally {
    vi.useRealTimers();
  }
});

it("releases an owned child session even when attachment answers after the deadline", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(true);
    const original = f.sendCommand.getMockImplementation()!;
    let attach!: (value: { sessionId: string }) => void;
    f.sendCommand.mockImplementation(async (method, params, session) => {
      if (method === "Target.attachToTarget")
        return new Promise((resolve) => {
          attach = resolve;
        });
      return original(method, params, session);
    });
    const failed = expect(capturePreviewSnapshotPage(f.guest, diagnostics)).rejects.toThrow(
      "timed out",
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(attach).toBeTypeOf("function");
    await vi.advanceTimersByTimeAsync(9_999);
    await failed;
    attach({ sessionId: "late-owned-session" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sendCommand).toHaveBeenCalledWith("Target.detachFromTarget", {
      sessionId: "late-owned-session",
    });
    expect(f.raw.listenerCount("did-start-navigation")).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
