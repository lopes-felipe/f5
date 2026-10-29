import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { buildPreviewPickScript, PREVIEW_PICK_INPUT_LAYER_ATTRIBUTE } from "./pickScript";

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
  const result = runInNewContext(buildPreviewPickScript(), {
    window,
    document,
    location: { href: "file:///doc.pdf" },
    Node: { ELEMENT_NODE: 1 },
    CSS: { escape: (value: string) => value },
  }) as Promise<{ element: { tagName: string } } | null>;
  const dispatch = (type: string, event: Record<string, unknown>) =>
    listeners.get(type)?.({ preventDefault: () => {}, stopPropagation: () => {}, ...event });
  const inputLayer = () =>
    documentElement.children.find((child) =>
      child.hasAttribute(PREVIEW_PICK_INPUT_LAYER_ATTRIBUTE),
    );
  return { result, dispatch, documentElement, body, embed, inputLayer, listeners };
}

describe("buildPreviewPickScript", () => {
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
});
