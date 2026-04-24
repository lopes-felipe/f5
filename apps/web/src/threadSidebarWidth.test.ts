import { describe, expect, it } from "vitest";

import {
  canAcceptThreadSidebarWidth,
  readInitialThreadSidebarWidth,
  readThreadSidebarWidthFromStorage,
  resolveAcceptedThreadSidebarWidth,
  THREAD_MAIN_PANEL_MIN_WIDTH_PX,
  THREAD_SIDEBAR_MAX_WIDTH_PX,
  THREAD_SIDEBAR_MIN_WIDTH_PX,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
} from "./threadSidebarWidth";

describe("readThreadSidebarWidthFromStorage", () => {
  it("falls back to the default width when storage is missing or invalid", () => {
    expect(
      readThreadSidebarWidthFromStorage({
        getItem: () => null,
      }),
    ).toBe(16 * 16);

    expect(
      readThreadSidebarWidthFromStorage({
        getItem: () => "not-a-number",
      }),
    ).toBe(16 * 16);
  });

  it("clamps persisted widths into the supported range", () => {
    expect(
      readThreadSidebarWidthFromStorage({
        getItem: (key) => (key === THREAD_SIDEBAR_WIDTH_STORAGE_KEY ? "64" : null),
      }),
    ).toBe(THREAD_SIDEBAR_MIN_WIDTH_PX);

    expect(
      readThreadSidebarWidthFromStorage({
        getItem: (key) => (key === THREAD_SIDEBAR_WIDTH_STORAGE_KEY ? "4096" : null),
      }),
    ).toBe(THREAD_SIDEBAR_MAX_WIDTH_PX);
  });

  it("returns the stored width when it is already valid", () => {
    expect(
      readThreadSidebarWidthFromStorage({
        getItem: (key) => (key === THREAD_SIDEBAR_WIDTH_STORAGE_KEY ? "320" : null),
      }),
    ).toBe(320);
  });

  it("falls back to the default width when storage throws", () => {
    expect(
      readThreadSidebarWidthFromStorage({
        getItem: () => {
          throw new Error("storage unavailable");
        },
      }),
    ).toBe(16 * 16);
  });
});

function createMockStyle(initialWidth: string) {
  const properties = new Map<string, string>();
  if (initialWidth.length > 0) {
    properties.set("--sidebar-width", initialWidth);
  }

  return {
    getPropertyValue(name: string) {
      return properties.get(name) ?? "";
    },
    removeProperty(name: string) {
      properties.delete(name);
    },
    setProperty(name: string, value: string) {
      properties.set(name, value);
    },
  };
}

function createMockWrapper(options: {
  initialWidth: number;
  mainPaneBaseWidth: number;
  rightSidebarWidth?: number;
}) {
  const style = createMockStyle(`${options.initialWidth}px`);
  const mainPane = {
    getBoundingClientRect: () => {
      const currentSidebarWidth = Number.parseFloat(style.getPropertyValue("--sidebar-width")) || 0;
      return {
        width: options.mainPaneBaseWidth - currentSidebarWidth - (options.rightSidebarWidth ?? 0),
      } as DOMRect;
    },
  };

  return {
    style,
    querySelector: (selector: string) =>
      selector === "main[data-slot='sidebar-inset']" ? (mainPane as HTMLElement) : null,
  } as HTMLElement;
}

describe("canAcceptThreadSidebarWidth", () => {
  it("returns true when the main pane is unavailable", () => {
    const wrapper = {
      querySelector: () => null,
      style: createMockStyle("256px"),
    } as unknown as HTMLElement;

    expect(
      canAcceptThreadSidebarWidth({
        nextWidth: 512,
        wrapper,
      }),
    ).toBe(true);
  });

  it("rejects widths that would shrink the main pane below the minimum and restores the previous width", () => {
    const wrapper = createMockWrapper({
      initialWidth: 256,
      mainPaneBaseWidth: 900,
    });

    expect(
      canAcceptThreadSidebarWidth({
        nextWidth: 512,
        wrapper,
      }),
    ).toBe(false);
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe("256px");
  });

  it("keeps rejecting oversize widths when inline diff is open", () => {
    const wrapper = createMockWrapper({
      initialWidth: 256,
      mainPaneBaseWidth: 1_200,
      rightSidebarWidth: 460,
    });

    expect(
      canAcceptThreadSidebarWidth({
        nextWidth: 400,
        wrapper,
      }),
    ).toBe(false);
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe("256px");
  });

  it("accepts widths that keep the main pane at or above the minimum", () => {
    const wrapper = createMockWrapper({
      initialWidth: 256,
      mainPaneBaseWidth: 1_200,
    });

    expect(
      canAcceptThreadSidebarWidth({
        nextWidth: 512,
        wrapper,
      }),
    ).toBe(true);
    expect(
      Number.parseFloat(wrapper.style.getPropertyValue("--sidebar-width")) +
        THREAD_MAIN_PANEL_MIN_WIDTH_PX,
    ).toBeGreaterThanOrEqual(768);
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe("256px");
  });
});

describe("resolveAcceptedThreadSidebarWidth", () => {
  it("shrinks an invalid preferred width to the largest accepted width", () => {
    const wrapper = createMockWrapper({
      initialWidth: 256,
      mainPaneBaseWidth: 900,
    });

    const resolvedWidth = resolveAcceptedThreadSidebarWidth({
      preferredWidth: 512,
      wrapper,
    });

    expect(resolvedWidth).toBeLessThan(512);
    expect(resolvedWidth).toBeGreaterThanOrEqual(THREAD_SIDEBAR_MIN_WIDTH_PX);
    expect(
      canAcceptThreadSidebarWidth({
        nextWidth: resolvedWidth,
        wrapper,
      }),
    ).toBe(true);
  });
});

describe("readInitialThreadSidebarWidth", () => {
  it("falls back to the default width when window is unavailable", () => {
    expect(readInitialThreadSidebarWidth()).toBe(16 * 16);
  });
});
