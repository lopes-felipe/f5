import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { buildPreviewAutomationSnapshotScript, capturePreviewSnapshotPage } from "./snapshotScript";

const emptyDiagnostics = { consoleEntries: [], networkEntries: [], actionTimeline: [] };
const field = (
  value: string,
  options: { type?: string; dotted?: boolean; defaultValue?: string } = {},
) => ({
  nodeType: 1,
  tagName: "INPUT",
  localName: "input",
  id: "",
  parentElement: null,
  type: options.type ?? "password",
  value,
  defaultValue: options.defaultValue ?? "",
  textContent: "",
  innerText: "",
  dotted: options.dotted ?? false,
  getAttribute: () => null,
  getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 }),
});

function capture(
  fields: ReturnType<typeof field>[],
  text: string,
  consoleText = "",
  shadowFields: ReturnType<typeof field>[] = [],
  options: Parameters<typeof buildPreviewAutomationSnapshotScript>[1] = {},
) {
  const shadow = { shadowRoot: { querySelectorAll: () => shadowFields } };
  const document = {
    title: "Page",
    readyState: "complete",
    body: { innerText: text },
    querySelectorAll: (selector: string) => (selector === "*" ? [...fields, shadow] : fields),
  };
  return runInNewContext(
    buildPreviewAutomationSnapshotScript(
      {
        ...emptyDiagnostics,
        consoleEntries: consoleText
          ? [{ level: "log", text: consoleText, timestamp: "2026-10-18T00:00:00Z" }]
          : [],
      } as Parameters<typeof buildPreviewAutomationSnapshotScript>[0],
      options,
    ),
    {
      document,
      location: { href: "https://example.com" },
      Node: { ELEMENT_NODE: 1 },
      CSS: { escape: (value: string) => value },
      getComputedStyle: (element: { dotted?: boolean }) => ({
        visibility: "visible",
        display: "block",
        getPropertyValue: () => (element.dotted ? "disc" : "none"),
      }),
    },
  );
}

describe("preview snapshot secret redaction", () => {
  it("redacts values from element names, reflected text, and console entries", () => {
    const snapshot = capture(
      [field("credential-value")],
      "Welcome credential-value",
      "logged credential-value",
    );
    expect(JSON.stringify(snapshot)).not.toContain("credential-value");
    expect(snapshot.interactiveElements[0].name).toBe("••••••••");
    expect(snapshot.visibleText).toBe("Welcome ••••••••");
  });

  it("includes default values, CSS-masked fields, and open shadow roots", () => {
    const snapshot = capture(
      [
        field("current-value", { defaultValue: "old-value" }),
        field("dotted-value", { type: "text", dotted: true }),
      ],
      "current-value old-value dotted-value shadow-value",
      "",
      [field("shadow-value")],
    );
    expect(snapshot.visibleText).toBe("•••••••• •••••••• •••••••• ••••••••");
  });

  it("redacts before truncation so a partial credential cannot escape at the boundary", () => {
    const snapshot = capture([field("boundary-secret")], "x".repeat(19_995) + "boundary-secret");
    expect(snapshot.visibleText).toBe("x".repeat(19_995) + "•••••");
  });

  it("retains serialized-secret lookahead without transferring an unbounded body", () => {
    const secret = "\u0001".repeat(3000);
    const encoded = JSON.stringify(secret).slice(1, -1);
    expect(capture([field(secret)], "x".repeat(19_995) + encoded).visibleText).toBe(
      "x".repeat(19_995) + "•••••",
    );
    expect(
      capture([], "x".repeat(1_000_000), "", [], { truncateVisibleText: false }).visibleText.length,
    ).toBe(20_000 + 6 * 16_384);
  });

  it("masks large serialized values or fails closed without printing a protected regex", () => {
    const secret = "\u0001".repeat(7000);
    let result;
    let failure: unknown;
    try {
      result = capture([field(secret)], JSON.stringify(secret));
    } catch (error) {
      failure = error;
    }
    // V8's compilation limit differs across supported Node/Electron versions.
    if (failure) {
      expect(failure).toMatchObject({
        name: "Error",
        message: "Protected fields could not be redacted safely. No snapshot was taken.",
      });
      expect(String(failure)).not.toContain(JSON.stringify(secret).slice(1, -1));
    } else expect(result.visibleText).toBe('"••••••••"');
  });

  it("fails closed for a protected value too large to redact", () => {
    expect(() => capture([field("x".repeat(16_385))], "page")).toThrow("No snapshot was taken");
  });

  it("bounds the number of protected-value matchers", () => {
    expect(() =>
      capture(
        Array.from({ length: 4097 }, (_, i) => field(`credential-${i}`)),
        "page",
      ),
    ).toThrow("No snapshot was taken");
  });

  it("keeps ordinary visible text inputs readable", () => {
    const snapshot = capture([field("search term", { type: "text" })], "Search results");
    expect(snapshot.interactiveElements[0].name).toBe("search term");
  });

  it.each(["a", "ab", "abc"])(
    "masks a short credential (%s) without corrupting field names or ordinary words",
    (secret) => {
      const snapshot = capture([field(secret)], `Search ${secret} and alphabet`);
      expect(snapshot.visibleText).toBe("Search •••••••• and alphabet");
      expect(snapshot.interactiveElements[0]).toMatchObject({ tag: "input", name: "••••••••" });
    },
  );

  it.each(["tag", "role", "visibleText"])(
    "preserves the snapshot schema when a credential equals %s",
    (secret) => {
      const snapshot = capture([field(secret)], `Value ${secret}`);
      expect(snapshot.visibleText).toBe("Value ••••••••");
      expect(snapshot.interactiveElements[0].tag).toBe("input");
    },
  );

  it.each([".", "+", "[", "\\"])("treats a short punctuation credential %s literally", (secret) => {
    expect(capture([field(secret)], `Value ${secret}`).visibleText).toBe("Value ••••••••");
  });

  it("normalizes hidden separators and whitespace without matching a short credential inside Unicode words", () => {
    expect(capture([field("\u200btop\tsecret\u00ad")], "top secret").visibleText).toBe("••••••••");
    expect(capture([field("a")], "éaé αaβ a").visibleText).toBe("éaé αaβ ••••••••");
  });
});

function guestWith(evaluate: () => Promise<unknown>) {
  const emitter = new EventEmitter();
  const evaluateScript = vi.fn((_worldId: number, _scripts: unknown[]) => evaluate());
  const guest = Object.assign(emitter, {
    executeJavaScriptInIsolatedWorld: evaluateScript,
    mainFrame: { framesInSubtree: [{ frameTreeNodeId: 1, processId: 1, frameToken: "main" }] },
    debugger: {
      isAttached: () => true,
      attach: vi.fn(),
      sendCommand: vi.fn(async (method: string) => {
        if (method === "Page.getFrameTree")
          return { frameTree: { frame: { id: "main", loaderId: "main" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
        if (method === "Runtime.evaluate") return { result: { value: [] } };
        throw new Error("Unexpected debugger command");
      }),
    },
  });
  return {
    emitter,
    evaluateScript,
    guest: guest as unknown as Parameters<typeof capturePreviewSnapshotPage>[0],
  };
}

describe("isolated snapshot capture", () => {
  it("uses an isolated world and releases its navigation listener", async () => {
    const { guest, emitter, evaluateScript } = guestWith(async () => ({ visibleText: "safe" }));
    expect(await capturePreviewSnapshotPage(guest, emptyDiagnostics)).toEqual({
      visibleText: "safe",
    });
    expect(evaluateScript.mock.calls[0]?.[0]).toBe(1007);
    expect(emitter.listenerCount("did-start-navigation")).toBe(0);
  });

  it("rejects a capture if navigation starts before it completes", async () => {
    let done!: (value: unknown) => void;
    const { guest, emitter } = guestWith(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const capture = capturePreviewSnapshotPage(guest, emptyDiagnostics);
    await vi.waitFor(() => expect(done).toBeTypeOf("function"));
    emitter.emit("did-start-navigation");
    done({ visibleText: "stale" });
    await expect(capture).rejects.toThrow("page changed");
    expect(emitter.listenerCount("did-start-navigation")).toBe(0);
  });

  it("bounds a hung capture and releases its listener", async () => {
    vi.useFakeTimers();
    try {
      const { guest, emitter } = guestWith(() => new Promise(() => {}));
      const result = expect(capturePreviewSnapshotPage(guest, emptyDiagnostics)).rejects.toThrow(
        "timed out",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
      expect(emitter.listenerCount("did-start-navigation")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
