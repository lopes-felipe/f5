import { describe, expect, it, vi } from "vitest";
import {
  COMPUTER_TOOL_DEFINITIONS,
  compactInspectResult,
  computerToolInputJsonSchema,
  callComputerTool,
  ComputerToolGeometry,
} from "./computerMcpTools";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import type { ComputerInspectResult } from "@t3tools/contracts";
import type { ComputerAutomationBrokerRuntime } from "./ComputerAutomationBroker";
const display = {
  displayId: "d",
  geometryGeneration: "g",
  primary: true,
  rotation: 0,
  nativeBounds: { x: 0, y: 0, width: 100, height: 100 },
  pixelSize: { width: 100, height: 100 },
  modelSize: { width: 100, height: 100 },
};
function setup(displays = [display], delivery: "foreground" | "background" = "foreground") {
  const invoke = vi.fn(
    async (_thread: string, _session: string, input: { op: string }): Promise<unknown> =>
      input.op === "screenshot"
        ? {
            displayId: "d",
            geometryGeneration: "g",
            modelSize: display.modelSize,
            mimeType: "image/jpeg",
            data: "aGVsbG8=",
            hiddenContent: true,
          }
        : {},
  );
  const broker = {
    invoke,
    host: { status: () => ({ available: true, displays }) },
    requestAccess: vi.fn(async () => ({})),
    requestForeground: vi.fn(async () => ({ foreground: true, appId: "one" })),
    classify: vi.fn(async () => delivery),
    access: { grants: () => [{ appId: "one", tier: "full" }] },
    reportToolFailure: vi.fn(),
    reportToolCompleted: vi.fn(),
    wait: vi.fn(async () => ({ waitedMs: 100, timedOut: true })),
    waitForTarget: vi.fn(async () => ({
      available: false,
      timedOut: true,
      reason: "user-active",
      requiresFreshObservation: true,
    })),
  };
  return {
    invoke,
    broker,
    context: {
      broker: broker as unknown as ComputerAutomationBrokerRuntime,
      threadId: "t",
      sessionGeneration: "s",
      geometry: new ComputerToolGeometry(),
    },
  };
}
describe("shared computer tool catalog", () => {
  it("waits for availability without observing or opening consent", async () => {
    const h = setup();
    const waited = await callComputerTool(h.context, "computer_wait_for_target", {
      app: "TextEdit",
      timeoutMs: 30_000,
    });
    expect(waited.structuredContent).toMatchObject({
      available: false,
      timedOut: true,
      reason: "user-active",
      requiresFreshObservation: true,
    });
    expect(h.broker.waitForTarget).toHaveBeenCalledWith("t", "s", {
      app: "TextEdit",
      timeoutMs: 30_000,
    });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.broker.requestAccess).not.toHaveBeenCalled();
    const foreground = await callComputerTool(h.context, "computer_wait_for_target", {});
    expect(foreground.isError).not.toBe(true);
    expect(h.broker.waitForTarget).toHaveBeenLastCalledWith("t", "s", {});
    expect(
      (await callComputerTool(h.context, "computer_wait_for_target", { timeoutMs: 99 })).isError,
    ).toBe(true);
    expect(
      (await callComputerTool(h.context, "computer_wait_for_target", { timeoutMs: 30_001 }))
        .isError,
    ).toBe(true);
  });
  it("reports safe pre-dispatch failures without screen contents or invalid argument values", async () => {
    const h = setup();
    await callComputerTool(h.context, "computer_type", { text: { secret: "PRIVATE_SENTINEL" } });
    expect(h.broker.reportToolFailure).toHaveBeenLastCalledWith(
      "t",
      "s",
      "type",
      "invalid-arguments",
    );
    expect(h.invoke).not.toHaveBeenCalled();
    h.invoke.mockResolvedValue([
      { appId: "one", name: "Fixture" },
      { appId: "two", name: "Fixture" },
    ]);
    await callComputerTool(h.context, "computer_element_action", {
      app: "Fixture",
      snapshotId: "snapshot",
      elementRef: "element",
      action: "press",
    });
    expect(h.broker.reportToolFailure).toHaveBeenLastCalledWith(
      "t",
      "s",
      "elementAction",
      "app-resolution-failed",
    );
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.broker.reportToolFailure.mock.calls)).not.toContain("PRIVATE_SENTINEL");
    h.broker.reportToolFailure.mockImplementation(() => {
      throw new Error("UI unavailable");
    });
    const result = await callComputerTool(h.context, "computer_click", { x: 1, y: 1 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { _tag: "Execution", message: "Take a computer_screenshot first." },
    });
  });
  it("routes an explicit typing upgrade to the shared grant gate", async () => {
    const h = setup();
    const response = await callComputerTool(h.context, "computer_request_access", {
      apps: ["Terminal"],
      reason: "Typing needed",
      typing: true,
    });
    expect(response.isError).toBeFalsy();
    expect(h.broker.requestAccess).toHaveBeenCalledWith(
      "t",
      "s",
      ["Terminal"],
      "Typing needed",
      true,
    );
  });
  it("preserves completed input when its post-action screenshot fails", async () => {
    const h = setup();
    h.invoke.mockResolvedValue({ actionCompleted: true, screenshotError: "Unavailable" });
    const result = await callComputerTool(h.context, "computer_key", { keys: "Enter" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      actionCompleted: true,
      screenshotError: "Unavailable",
    });
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });
  it("documents down/right scroll directions consistently", () => {
    expect(
      COMPUTER_TOOL_DEFINITIONS.find((tool) => tool.name === "computer_scroll")?.description,
    ).toContain("Positive deltaY scrolls down; positive deltaX scrolls right.");
  });
  it("installs one catalog of eighteen tools, with only discovery tools always loaded", () => {
    expect(COMPUTER_TOOL_DEFINITIONS).toHaveLength(18);
    expect(COMPUTER_TOOL_DEFINITIONS.map((tool) => tool.name)).toContain(
      "computer_request_foreground",
    );
    expect(
      COMPUTER_TOOL_DEFINITIONS.filter((tool) => tool.alwaysLoad).map((tool) => tool.name),
    ).toEqual(["computer_status", "computer_request_access"]);
  });
  it("requires fresh screenshot geometry, uses display screenshot pixels and clears on resume", async () => {
    const h = setup();
    expect((await callComputerTool(h.context, "computer_click", { x: 3, y: 4 })).isError).toBe(
      true,
    );
    expect(h.invoke).not.toHaveBeenCalled();
    const screenshot = await callComputerTool(h.context, "computer_screenshot", {});
    expect(screenshot.content).toContainEqual({
      type: "image",
      mimeType: "image/jpeg",
      data: "aGVsbG8=",
    });
    expect(JSON.stringify(screenshot.structuredContent)).not.toContain("aGVsbG8=");
    await callComputerTool(h.context, "computer_click", { x: 3, y: 4 });
    expect(h.invoke).toHaveBeenLastCalledWith(
      "t",
      "s",
      expect.objectContaining({
        op: "click",
        displayId: "d",
        geometryGeneration: "g",
        screenshot: true,
      }),
      undefined,
      expect.objectContaining({ onDispatch: expect.any(Function) }),
    );
    h.context.geometry.clear();
    expect((await callComputerTool(h.context, "computer_move", { x: 3, y: 4 })).isError).toBe(true);
  });
  it("classifies background screenshots before display selection and keys them by app scope", async () => {
    const h = setup([display, { ...display, displayId: "other" }], "background");
    h.invoke.mockImplementation(async (_thread, _session, input) =>
      input.op === "screenshot"
        ? {
            displayId: "d",
            geometryGeneration: "g",
            modelSize: display.modelSize,
            mimeType: "image/jpeg",
            data: "aGVsbG8=",
            hiddenContent: true,
            captureScope: "app",
          }
        : [{ appId: "one", name: "Fixture" }],
    );
    const screenshot = await callComputerTool(h.context, "computer_screenshot", {
      app: "Fixture",
    });
    expect(screenshot.isError).toBeFalsy();
    expect(h.broker.classify).toHaveBeenCalledWith("t", "s", "screenshot", "one", {
      executionMode: undefined,
      action: undefined,
    });
    const call = h.invoke.mock.calls.find(([, , input]) => input.op === "screenshot")![2];
    expect(call).toMatchObject({ op: "screenshot", appId: "one" });
    expect(call).not.toHaveProperty("displayId");
    // An app-scoped capture never authorizes display coordinates.
    expect(() => h.context.geometry.generation("d")).toThrow("Take a computer_screenshot first.");
    // A later lookup of the same granted app resolves from the cache.
    await callComputerTool(h.context, "computer_zoom", {
      app: "Fixture",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(h.invoke.mock.calls.filter(([, , input]) => input.op === "resolveApps")).toHaveLength(1);
  });
  it("never treats an app-scoped capture as display evidence, even in foreground mode", async () => {
    const h = setup();
    h.invoke.mockImplementation(async (_thread, _session, input) =>
      input.op === "screenshot"
        ? {
            displayId: "d",
            geometryGeneration: "g",
            modelSize: display.modelSize,
            mimeType: "image/jpeg",
            data: "aGVsbG8=",
            hiddenContent: true,
            captureScope: "app",
          }
        : [{ appId: "one", name: "Fixture" }],
    );
    await callComputerTool(h.context, "computer_screenshot", { app: "Fixture" });
    expect((await callComputerTool(h.context, "computer_click", { x: 3, y: 4 })).isError).toBe(
      true,
    );
  });
  it("discards a screenshot that completes after an invalidation", async () => {
    const h = setup();
    let finish: (value: unknown) => void = () => {};
    h.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = callComputerTool(h.context, "computer_screenshot", {});
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(1));
    // A takeover, pause or policy revision lands while the capture is in flight.
    h.context.geometry.clear();
    finish({
      displayId: "d",
      geometryGeneration: "g",
      modelSize: display.modelSize,
      mimeType: "image/jpeg",
      data: "aGVsbG8=",
      hiddenContent: true,
    });
    await pending;
    expect((await callComputerTool(h.context, "computer_click", { x: 3, y: 4 })).isError).toBe(
      true,
    );
  });
  it("requires an app for background observations and routes foreground requests", async () => {
    const h = setup([display], "background");
    const missing = await callComputerTool(h.context, "computer_screenshot", {});
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({
      error: { message: "Specify app: the app to act in." },
    });
    expect(h.broker.reportToolFailure).toHaveBeenLastCalledWith(
      "t",
      "s",
      "screenshot",
      "app-required",
    );
    expect(h.invoke).not.toHaveBeenCalled();
    const foreground = await callComputerTool(h.context, "computer_request_foreground", {
      app: "Fixture",
      reason: "Needs a drag",
    });
    expect(foreground.isError).toBeFalsy();
    expect(h.broker.requestForeground).toHaveBeenCalledWith("t", "s", "Fixture", "Needs a drag");
  });
  it("requires a display on multi-monitor machines before the first capture", async () => {
    const h = setup([display, { ...display, displayId: "other" }]);
    expect((await callComputerTool(h.context, "computer_screenshot", {})).isError).toBe(true);
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it.each([
    ["computer_type", { text: "x".repeat(10001) }],
    ["computer_click", { x: -1, y: 0 }],
    ["computer_key", { keys: "Enter", repeat: 21 }],
    ["computer_status", { execute: "raw native message" }],
    ["unknown_tool", {}],
  ])("never throws for invalid %s calls", async (tool, input) => {
    const h = setup();
    await expect(callComputerTool(h.context, tool, input)).resolves.toMatchObject({
      isError: true,
    });
    expect(h.invoke).not.toHaveBeenCalled();
  });
});

import {
  COMPUTER_GUIDANCE,
  COMPUTER_SAFETY_CLAUSE,
  classifyComputerTool,
} from "./computerMcpTools";
it("keeps guidance on discovery, safety on actions, and the serialized catalog below budget", () => {
  const baselineDescriptionCharacters = 16 * 1300; // Lower bound on the original repeated guidance alone.
  expect(
    COMPUTER_TOOL_DEFINITIONS.filter((tool) => tool.description.includes(COMPUTER_GUIDANCE)).map(
      (tool) => tool.name,
    ),
  ).toEqual(["computer_status"]);
  const length = JSON.stringify(COMPUTER_TOOL_DEFINITIONS.map((tool) => tool.description)).length;
  expect(length).toBeLessThanOrEqual(6000);
  expect(length).toBeLessThan(baselineDescriptionCharacters / 2);
  for (const tool of COMPUTER_TOOL_DEFINITIONS) {
    if (
      classifyComputerTool(tool.name) === "mutate" ||
      ["computer_screenshot", "computer_zoom", "computer_inspect", "computer_wait"].includes(
        tool.name,
      )
    )
      expect(tool.description).toContain(COMPUTER_SAFETY_CLAUSE);
  }
  expect(
    COMPUTER_TOOL_DEFINITIONS.find((tool) => tool.name === "computer_wait")?.annotations,
  ).toMatchObject({ readOnlyHint: true, idempotentHint: true });
});
it("merges wait metadata with the trailing image or capture failure and publishes exactly one history row", async () => {
  const h = setup();
  const result = await callComputerTool(h.context, "computer_wait", {
    screenshot: true,
    timeoutMs: 100,
  });
  expect(result.structuredContent).toMatchObject({ waitedMs: 100 });
  expect(result.content.some((block) => block.type === "image")).toBe(true);
  expect(h.broker.reportToolCompleted).toHaveBeenCalledExactlyOnceWith(
    "t",
    "s",
    "wait",
    undefined,
    undefined,
  );
  h.invoke.mockRejectedValue(new Error("capture-failed"));
  const failed = await callComputerTool(h.context, "computer_wait", { screenshot: true });
  expect(failed).toMatchObject({ isError: true, structuredContent: { waitedMs: 100 } });
  expect(h.broker.reportToolFailure).toHaveBeenCalledExactlyOnceWith("t", "s", "wait", "Execution");
  const invalid = await callComputerTool(h.context, "computer_wait", { role: "AXButton" });
  expect(invalid.isError).toBe(true);
});

it("records delivery per invocation and leaves a plain wait unbadged", async () => {
  const h = setup();
  h.context.geometry.rememberApps([
    { appId: "one", name: "Fixture", tier: "full", running: true, frontmost: true },
  ]);
  vi.spyOn(h.context.broker, "classify").mockImplementation(
    async (_thread, _generation, _op, _app, input) =>
      input.executionMode === "background" ? "background" : "foreground",
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let dispatched!: () => void;
  const admitted = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  vi.spyOn(h.context.broker, "invoke").mockImplementation(
    async (_thread, _generation, input, _timeout, options) => {
      options?.onDispatch?.(input.executionMode === "background" ? "background" : "foreground");
      if (input.executionMode === "background") {
        dispatched();
        await held;
      }
      return {};
    },
  );
  const first = callComputerTool(h.context, "computer_type", {
    app: "one",
    text: "first",
    executionMode: "background",
  });
  await admitted;
  await callComputerTool(h.context, "computer_type", {
    app: "one",
    text: "second",
    executionMode: "foreground",
  });
  release();
  await first;
  await callComputerTool(h.context, "computer_wait", { timeoutMs: 100 });
  expect(h.broker.reportToolCompleted.mock.calls).toEqual([
    ["t", "s", "type", "Fixture", "foreground"],
    ["t", "s", "type", "Fixture", "background"],
    ["t", "s", "wait", undefined, undefined],
  ]);
});

const inspectFixture = (count = 1): ComputerInspectResult => ({
  snapshotId: "s1",
  appId: "one",
  accessible: true,
  truncated: true,
  nodes: Array.from({ length: count }, (_, index) => ({
    elementRef: `e${index + 1}`,
    role: "AXStaticText",
    name: `Incident detail ${index + 1}`,
    value: "",
    displayId: "d",
    bounds: { x: 12, y: 34, width: 200, height: 20 },
    focused: false,
    enabled: true,
    actions: ["showMenu", "scrollIntoView"],
  })),
});
describe("compact computer observations", () => {
  it("drops defaults and weak actions, with shared display and compact bounds", () => {
    const tree = inspectFixture(3);
    const nodes = tree.nodes.map((node, index) => ({
      ...node,
      ...(index === 2
        ? {
            displayId: "other",
            name: "",
            value: "changed",
            focused: true,
            enabled: false,
            actions: ["press" as const, "showMenu" as const],
          }
        : {}),
    }));
    expect(compactInspectResult({ ...tree, nodes, executionNote: "Background" })).toEqual({
      snapshotId: "s1",
      appId: "one",
      accessible: true,
      truncated: true,
      displayId: "d",
      executionNote: "Background",
      nodes: [
        { ref: "e1", role: "AXStaticText", name: "Incident detail 1", b: [12, 34, 200, 20] },
        { ref: "e2", role: "AXStaticText", name: "Incident detail 2", b: [12, 34, 200, 20] },
        {
          ref: "e3",
          role: "AXStaticText",
          value: "changed",
          b: [12, 34, 200, 20],
          d: "other",
          focused: true,
          enabled: false,
          actions: ["press"],
        },
      ],
    });
    expect(JSON.stringify(compactInspectResult(inspectFixture(400))).length).toBeLessThan(40_000);
  });
  it("advertises the inspect default and opt-in cap in the MCP schema", () => {
    const tool = COMPUTER_TOOL_DEFINITIONS.find((tool) => tool.op === "inspect")!;
    const schema = computerToolInputJsonSchema(tool);
    expect(schema).toMatchObject({
      properties: { maxNodes: { minimum: 1, maximum: 800, default: 400 } },
    });
  });
  it("forwards subtree refs, defaults to 400, accepts 800 and rejects unpaired refs and 801", async () => {
    const h = setup();
    h.context.geometry.rememberApps([
      { appId: "one", name: "Fixture", tier: "full", running: true, frontmost: true },
    ]);
    h.invoke.mockResolvedValue(inspectFixture());
    const response = await callComputerTool(h.context, "computer_inspect", {
      app: "one",
      snapshotId: "old",
      elementRef: "e9",
    });
    expect(h.invoke).toHaveBeenLastCalledWith(
      "t",
      "s",
      expect.objectContaining({
        op: "inspect",
        maxNodes: 400,
        snapshotId: "old",
        elementRef: "e9",
      }),
      undefined,
      expect.any(Object),
    );
    expect(response.structuredContent).toEqual(compactInspectResult(inspectFixture()));
    expect(response.content).toEqual([
      { type: "text", text: JSON.stringify(response.structuredContent) },
    ]);
    expect(
      (await callComputerTool(h.context, "computer_inspect", { app: "one", maxNodes: 800 }))
        .isError,
    ).toBeFalsy();
    h.invoke.mockClear();
    for (const extra of [{ snapshotId: "s" }, { elementRef: "e1" }, { maxNodes: 801 }]) {
      expect(
        (await callComputerTool(h.context, "computer_inspect", { app: "one", ...extra })).isError,
      ).toBe(true);
    }
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.broker.reportToolFailure).toHaveBeenLastCalledWith(
      "t",
      "s",
      "inspect",
      "invalid-arguments",
    );
  });
  it.each(["computer_type", "computer_key", "computer_element_action"])(
    "attaches a fresh tree to %s with the same delivery",
    async (tool) => {
      const h = setup();
      h.context.geometry.rememberApps([
        { appId: "one", name: "Fixture", tier: "full", running: true, frontmost: true },
      ]);
      h.invoke
        .mockResolvedValueOnce({ frontmostApp: { appId: "one" }, actionCompleted: true })
        .mockResolvedValueOnce(inspectFixture());
      const args =
        tool === "computer_type"
          ? { text: "hi", app: "one" }
          : tool === "computer_key"
            ? { keys: "Down" }
            : { app: "one", snapshotId: "s", elementRef: "e1", action: "press" };
      const response = await callComputerTool(h.context, tool, {
        ...args,
        inspect: true,
        maxNodes: 800,
      });
      expect(response.isError).toBeFalsy();
      expect(response.structuredContent).toMatchObject({
        actionCompleted: true,
        inspect: compactInspectResult(inspectFixture()),
      });
      expect(h.invoke.mock.calls[0]?.[2]).not.toHaveProperty("inspect");
      expect(h.invoke.mock.calls[0]?.[2]).not.toHaveProperty("maxNodes");
      expect(h.invoke.mock.calls[1]?.[2]).toEqual({
        op: "inspect",
        appId: "one",
        maxNodes: 800,
        executionMode: "foreground",
      });
    },
  );
  it("keeps an action successful if the trailing inspect fails, and skips waiting actions", async () => {
    const h = setup();
    h.invoke
      .mockResolvedValueOnce({ frontmostApp: { appId: "one" }, actionCompleted: true })
      .mockRejectedValueOnce(
        new ComputerControlError({ _tag: "Unavailable", reason: "helper-crashed" }),
      );
    const response = await callComputerTool(h.context, "computer_key", {
      keys: "Down",
      inspect: true,
    });
    expect(response.isError).toBeFalsy();
    expect(response.structuredContent).toMatchObject({
      actionCompleted: true,
      inspectError: "Unavailable",
    });
    expect(h.broker.reportToolFailure).not.toHaveBeenCalled();
    h.invoke.mockClear().mockResolvedValue({ waiting: "secure-input", actionCompleted: false });
    await callComputerTool(h.context, "computer_type", { text: "hi", inspect: true });
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });
  it.each([
    [
      new ComputerControlError({ _tag: "StaleElement", reason: "window-changed" }),
      "StaleElement",
      "StaleElement (window-changed): call computer_inspect again.",
    ],
    [
      new ComputerControlError({ _tag: "ForegroundRequired", reason: "unsupported-in-background" }),
      "ForegroundRequired",
      "ForegroundRequired (unsupported-in-background): call computer_request_foreground with a short reason.",
    ],
    [new Error("Observation deadline expired."), "Execution", "Observation deadline expired."],
  ])(
    "keeps the action successful and preserves follow-up recovery text (%s)",
    async (cause, tag, message) => {
      const h = setup();
      h.invoke
        .mockResolvedValueOnce({ frontmostApp: { appId: "one" }, actionCompleted: true })
        .mockRejectedValueOnce(cause);
      const response = await callComputerTool(h.context, "computer_key", {
        keys: "Down",
        inspect: true,
      });
      expect(response.isError).toBeFalsy();
      expect(response.structuredContent).toMatchObject({
        actionCompleted: true,
        inspectError: tag,
        inspectErrorMessage: message,
      });
      expect(h.broker.reportToolFailure).not.toHaveBeenCalled();
    },
  );
  it("explains a missing target app without repeating the completed action", async () => {
    const h = setup();
    h.invoke.mockResolvedValueOnce({ frontmostApp: null, actionCompleted: true });
    const response = await callComputerTool(h.context, "computer_key", {
      keys: "Down",
      inspect: true,
    });
    expect(response.isError).toBeFalsy();
    expect(response.structuredContent).toMatchObject({
      actionCompleted: true,
      inspectError: "Execution",
      inspectErrorMessage: "Action did not identify an app.",
    });
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });
  it("documents platform caps and foreground-only element actions", () => {
    const description = COMPUTER_TOOL_DEFINITIONS.find(
      (tool) => tool.op === "inspect",
    )!.description;
    expect(description).toContain("Windows caps at 400");
    expect(description).toContain("Nodes outside the inspected window are omitted");
    expect(description).toContain("in foreground mode");
    expect(description).toContain("in background mode they require computer_request_foreground");
    expect(COMPUTER_TOOL_DEFINITIONS.find((tool) => tool.op === "key")!.description).toContain(
      "Control+Minus on Windows",
    );
  });
  it("does not remember an unresolved helper display", async () => {
    const h = setup([display, { ...display, displayId: "other" }]);
    h.invoke.mockResolvedValue({ displayId: "unknown" });
    await callComputerTool(h.context, "computer_key", { keys: "Down" });
    expect(() => h.context.geometry.display(undefined, [])).toThrow("Specify displayId");
    h.context.geometry.rememberActionDisplay("");
    expect(() => h.context.geometry.display(undefined, [])).toThrow("Specify displayId");
  });
  it("does not automatically capture keys, but honors an explicit screenshot", async () => {
    const h = setup();
    await callComputerTool(h.context, "computer_key", { keys: "Down" });
    expect(h.invoke.mock.calls[0]?.[2]).toMatchObject({ screenshot: false });
    await callComputerTool(h.context, "computer_key", { keys: "Meta+Minus", screenshot: true });
    expect(h.invoke.mock.calls[1]?.[2]).toMatchObject({ screenshot: true });
    expect(COMPUTER_TOOL_DEFINITIONS.find((tool) => tool.op === "key")?.description).toContain(
      "Meta+Minus on macOS",
    );
  });
  it("uses the last foreground action display without authorizing coordinates, and clears it", async () => {
    const h = setup([display, { ...display, displayId: "other" }]);
    h.invoke.mockResolvedValue({ displayId: "other" });
    await callComputerTool(h.context, "computer_key", { keys: "Down" });
    expect(h.context.geometry.display(undefined, [])).toBe("other");
    expect(() => h.context.geometry.generation("other")).toThrow(
      "Take a computer_screenshot first.",
    );
    h.context.geometry.observe({
      displayId: "d",
      geometryGeneration: "g",
      modelSize: display.modelSize,
      mimeType: "image/jpeg",
      data: "",
      hiddenContent: false,
    });
    expect(h.context.geometry.display(undefined, [])).toBe("d");
    expect(h.context.geometry.display("explicit", [])).toBe("explicit");
    h.context.geometry.clear();
    expect(() => h.context.geometry.display(undefined, [])).toThrow("Specify displayId");
  });
  it("does not restore an action display after a later observation invalidation", async () => {
    const h = setup([display, { ...display, displayId: "other" }]);
    let finish: (value: unknown) => void = () => {};
    h.invoke.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = callComputerTool(h.context, "computer_key", { keys: "Down" });
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(1));
    h.context.geometry.clear();
    finish({ displayId: "other" });
    await pending;
    expect(() => h.context.geometry.display(undefined, [])).toThrow("Specify displayId");
  });
  it.each(["fast", "conservative", undefined])(
    "preserves actual masking mode and labels missing metadata (%s)",
    async (passwordMasking) => {
      const h = setup();
      const secureAudit = { searchEnabled: false, elapsedMs: 3, windows: [] };
      h.invoke.mockResolvedValue({
        displayId: "d",
        geometryGeneration: "g",
        data: "aGVsbG8=",
        mimeType: "image/jpeg",
        masked: "web-area",
        maskReasons: ["partial-audit"],
        hiddenContent: true,
        secureAudit,
        ...(passwordMasking ? { passwordMasking } : {}),
      });
      const response = await callComputerTool(h.context, "computer_screenshot", {});
      expect(response.structuredContent).toMatchObject({
        masked: "web-area",
        maskReasons: ["partial-audit"],
        hiddenContent: true,
        secureAudit,
        ...(passwordMasking ? { passwordMasking } : { passwordMaskingNote: "Legacy / unknown" }),
      });
      expect(response.structuredContent).not.toHaveProperty("data");
      expect(response.content[0]).toEqual({
        type: "text",
        text: JSON.stringify(response.structuredContent),
      });
      expect(COMPUTER_GUIDANCE).toContain("best-effort detection");
      expect(COMPUTER_GUIDANCE).toContain("complete audit does not guarantee");
    },
  );
  it("explains why an element reference is stale", async () => {
    const h = setup();
    h.invoke.mockRejectedValue(
      new ComputerControlError({ _tag: "StaleElement", reason: "window-changed" }),
    );
    const response = await callComputerTool(h.context, "computer_key", { keys: "Down" });
    expect(response.content).toEqual([
      { type: "text", text: "StaleElement (window-changed): call computer_inspect again." },
    ]);
  });
});
