import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { PreviewPicker } from "./PreviewPicker";
import { PREVIEW_PICK_INPUT_LAYER_ATTRIBUTE, PREVIEW_PICK_WORLD_ID } from "./pickScript";

interface FakeElement {
  nodeType: number;
  localName: string;
  id: string;
  parentElement: FakeElement | null;
  children: FakeElement[];
  attributes: Map<string, string>;
  style: Record<string, string>;
  tabIndex?: number;
  outerHTML: string;
  textContent: string;
  innerText: string;
  focus: ReturnType<typeof vi.fn>;
  setAttribute: (name: string, value: string) => void;
  hasAttribute: (name: string) => boolean;
  append: (...nodes: FakeElement[]) => void;
  remove: () => void;
  getBoundingClientRect: () => {
    x: number;
    y: number;
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

function element(localName: string, parent: FakeElement | null = null): FakeElement {
  const node: FakeElement = {
    nodeType: 1,
    localName,
    id: "",
    parentElement: parent,
    children: [],
    attributes: new Map(),
    style: {},
    outerHTML: `<${localName}>`,
    textContent: "",
    innerText: "",
    focus: vi.fn(),
    setAttribute: (name, value) => node.attributes.set(name, value),
    hasAttribute: (name) => node.attributes.has(name),
    append: (...nodes) => {
      for (const child of nodes) {
        child.parentElement = node;
        node.children.push(child);
      }
    },
    remove: () => {
      const siblings = node.parentElement?.children;
      if (siblings) siblings.splice(siblings.indexOf(node), 1);
    },
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 800, height: 600 }),
  };
  parent?.children.push(node);
  return node;
}

type Listener = (event: Record<string, unknown>) => void;

function startPick(contentType: string) {
  const documentElement = element("html");
  const body = element("body", documentElement);
  const embed = element("embed", body);
  const listeners = new Map<string, Listener>();
  const window: Record<string, unknown> = {
    innerWidth: 800,
    innerHeight: 600,
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const document = {
    contentType,
    title: "doc.pdf",
    documentElement,
    body,
    createElement: (localName: string) => element(localName),
    // The input layer sits above everything else at the pointer.
    elementsFromPoint: () => [
      ...documentElement.children.filter((child) => child !== body),
      embed,
      body,
      documentElement,
    ],
  };
  const context = {
    window,
    document,
    location: { href: "file:///doc.pdf" },
    Node: { ELEMENT_NODE: 1 },
    CSS: { escape: (value: string) => value },
  };
  const guest = Object.assign(new EventEmitter(), {
    getURL: vi.fn(() => context.location.href),
    isLoadingMainFrame: vi.fn(() => false),
    executeJavaScriptInIsolatedWorld: vi.fn(
      async (worldId: number, scripts: Electron.WebSource[]) => {
        expect(worldId).toBe(PREVIEW_PICK_WORLD_ID);
        return runInNewContext(scripts[0]!.code, context);
      },
    ),
  });
  const picker = new PreviewPicker();
  const run = (automationActive = false) => picker.pick(guest, automationActive);
  const result = run();
  const dispatch = (type: string, event: Record<string, unknown>) =>
    listeners.get(type)?.({
      isTrusted: true,
      preventDefault: () => {},
      stopPropagation: () => {},
      ...event,
    });
  const inputLayers = () =>
    documentElement.children.filter((child) =>
      child.hasAttribute(PREVIEW_PICK_INPUT_LAYER_ATTRIBUTE),
    );
  const inputLayer = () => inputLayers()[0];
  const cancel = () => picker.cancel(guest);
  return {
    result,
    run,
    cancel,
    picker,
    guest,
    dispatch,
    window,
    documentElement,
    body,
    embed,
    inputLayer,
    inputLayers,
    listeners,
  };
}

describe("PreviewPicker", () => {
  it("keeps picking after a page dispatches a synthetic click or Escape", async () => {
    const pick = startPick("text/html");
    const preventDefault = vi.fn();
    pick.dispatch("click", { isTrusted: false, target: pick.body, preventDefault });
    pick.dispatch("keydown", { isTrusted: false, key: "Escape", preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(pick.listeners.has("click")).toBe(true);

    pick.dispatch("click", { target: pick.embed });
    await expect(pick.result).resolves.toMatchObject({ element: { tagName: "embed" } });
  });

  it("adds no input layer on ordinary pages", async () => {
    const pick = startPick("text/html");
    expect(pick.inputLayer()).toBeUndefined();
    pick.dispatch("click", { target: pick.body });
    await expect(pick.result).resolves.toMatchObject({ element: { tagName: "body" } });
  });

  it("picks through a focused input layer on PDF pages and removes it afterwards", async () => {
    const pick = startPick("application/pdf");
    const layer = pick.inputLayer();
    expect(layer).toBeDefined();
    expect(layer!.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(layer!.style.cssText).toContain("position:fixed;inset:0");

    pick.dispatch("click", { target: layer, clientX: 10, clientY: 10 });
    await expect(pick.result).resolves.toMatchObject({ element: { tagName: "embed" } });
    expect(pick.inputLayer()).toBeUndefined();
    expect(pick.documentElement.children).toEqual([pick.body]);
    expect(pick.listeners.size).toBe(0);
  });

  it("cancels with Escape on PDF pages", async () => {
    const pick = startPick("application/pdf");
    pick.dispatch("keydown", { key: "Escape", target: pick.inputLayer() });
    await expect(pick.result).resolves.toBeNull();
    expect(pick.inputLayer()).toBeUndefined();
  });

  it("highlights the element under the input layer on hover", () => {
    const pick = startPick("application/pdf");
    const [overlay, label] = pick.documentElement.children.filter(
      (child) => child !== pick.body && child !== pick.inputLayer(),
    );
    pick.dispatch("mousemove", { target: pick.inputLayer(), clientX: 10, clientY: 10 });
    expect(overlay!.style.display).toBe("block");
    expect(label!.textContent).toBe("embed");
  });

  it("removes the input layer when the host cancels the pick", async () => {
    const pick = startPick("application/pdf");
    expect(() => pick.picker.assertAutomationAllowed(pick.guest)).toThrow(
      "The user is picking an element",
    );
    await pick.cancel();
    await expect(pick.result).resolves.toBeNull();
    expect(pick.documentElement.children).toEqual([pick.body]);
    expect(pick.listeners.size).toBe(0);
    expect(pick.window.__f5PreviewPicker).toBeUndefined();
    expect(() => pick.picker.assertAutomationAllowed(pick.guest)).not.toThrow();
  });

  it("keeps a single input layer when a pick restarts", async () => {
    const pick = startPick("application/pdf");
    const restarted = pick.run();
    await expect(pick.result).resolves.toBeNull();
    expect(pick.inputLayers()).toHaveLength(1);

    pick.dispatch("click", { target: pick.inputLayer(), clientX: 10, clientY: 10 });
    await expect(restarted).resolves.toMatchObject({ element: { tagName: "embed" } });
    expect(pick.documentElement.children).toEqual([pick.body]);
  });

  it("keeps a restarted pick active if an earlier cancellation arrives late", async () => {
    const pick = startPick("text/html");
    const evaluate = pick.guest.executeJavaScriptInIsolatedWorld.getMockImplementation()!;
    let dispatchCancel!: () => void;
    pick.guest.executeJavaScriptInIsolatedWorld.mockImplementationOnce(
      (worldId, scripts) =>
        new Promise((resolve) => {
          dispatchCancel = () => resolve(evaluate(worldId, scripts));
        }),
    );
    const cancellation = pick.cancel();
    const restarted = pick.run();
    await expect(pick.result).resolves.toBeNull();
    dispatchCancel();
    await cancellation;
    expect(() => pick.picker.assertAutomationAllowed(pick.guest)).toThrow();
    pick.dispatch("click", { target: pick.embed });
    await expect(restarted).resolves.toMatchObject({ element: { tagName: "embed" } });
  });

  it.each(["did-navigate", "destroyed", "render-process-gone"])(
    "releases pending picks and automation on %s",
    async (event) => {
      const pick = startPick("text/html");
      pick.guest.emit(event);
      await expect(pick.result).resolves.toBeNull();
      expect(pick.guest.eventNames()).toEqual([]);
      expect(() => pick.picker.assertAutomationAllowed(pick.guest)).not.toThrow();
    },
  );

  it("cleans up the overlay before the document can enter the back-forward cache", async () => {
    const pick = startPick("application/pdf");
    pick.dispatch("pagehide", { isTrusted: false });
    expect(pick.inputLayer()).toBeDefined();
    pick.dispatch("pagehide", { persisted: true });
    await expect(pick.result).resolves.toBeNull();
    expect(pick.inputLayers()).toHaveLength(0);
    expect(pick.listeners.size).toBe(0);
  });

  it("refuses to inject while automation is active or the main frame is loading", async () => {
    const pick = startPick("text/html");
    await pick.cancel();
    await pick.result;
    pick.guest.executeJavaScriptInIsolatedWorld.mockClear();
    await expect(pick.run(true)).rejects.toThrow("current browser automation action");
    pick.guest.isLoadingMainFrame.mockReturnValue(true);
    await expect(pick.run()).rejects.toThrow("finish loading");
    expect(pick.guest.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect(() => pick.picker.assertAutomationAllowed(pick.guest)).not.toThrow();
  });
});
