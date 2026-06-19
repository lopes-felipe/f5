import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { selectThreadRightPanelState, useRightPanelStore } from "./rightPanelStore";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");

describe("rightPanelStore", () => {
  beforeEach(() => {
    useRightPanelStore.setState({ byThreadId: {} });
  });

  it("opens singleton surfaces and focuses the last opened surface", () => {
    useRightPanelStore.getState().open(THREAD_A, "diff");
    useRightPanelStore.getState().open(THREAD_A, "plan");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A)).toEqual(
      {
        isOpen: true,
        activeSurfaceId: "plan",
        surfaces: [
          { id: "diff", kind: "diff" },
          { id: "plan", kind: "plan" },
        ],
      },
    );
  });

  it("updates an existing file surface and keeps its tab order", () => {
    useRightPanelStore.getState().open(THREAD_A, "diff");
    useRightPanelStore.getState().openFile(THREAD_A, {
      relativePath: "src/app.ts",
      line: 1,
    });
    useRightPanelStore.getState().openFile(THREAD_A, {
      relativePath: "src/app.ts",
      line: 42,
      endLine: 44,
      column: 7,
    });

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A)).toEqual(
      {
        isOpen: true,
        activeSurfaceId: "file:src/app.ts",
        surfaces: [
          { id: "diff", kind: "diff" },
          {
            id: "file:src/app.ts",
            kind: "file",
            relativePath: "src/app.ts",
            line: 42,
            endLine: 44,
            column: 7,
          },
        ],
      },
    );
  });

  it("closing the active surface falls back to the neighbor", () => {
    useRightPanelStore.getState().open(THREAD_A, "diff");
    useRightPanelStore.getState().open(THREAD_A, "plan");

    useRightPanelStore.getState().closeSurface(THREAD_A, "plan");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A)).toEqual(
      {
        isOpen: true,
        activeSurfaceId: "diff",
        surfaces: [{ id: "diff", kind: "diff" }],
      },
    );
  });

  it("supports close other, close to right, and close all actions", () => {
    useRightPanelStore.getState().open(THREAD_A, "diff");
    useRightPanelStore.getState().openFile(THREAD_A, { relativePath: "src/app.ts" });
    useRightPanelStore.getState().open(THREAD_A, "plan");

    useRightPanelStore.getState().closeSurfacesToRight(THREAD_A, "diff");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A)).toEqual(
      {
        isOpen: true,
        activeSurfaceId: "diff",
        surfaces: [{ id: "diff", kind: "diff" }],
      },
    );

    useRightPanelStore.getState().openFile(THREAD_A, { relativePath: "src/app.ts" });
    useRightPanelStore.getState().open(THREAD_A, "plan");
    useRightPanelStore.getState().closeOtherSurfaces(THREAD_A, "file:src/app.ts");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A)).toEqual(
      {
        isOpen: true,
        activeSurfaceId: "file:src/app.ts",
        surfaces: [{ id: "file:src/app.ts", kind: "file", relativePath: "src/app.ts" }],
      },
    );

    useRightPanelStore.getState().closeAllSurfaces(THREAD_A);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A)).toEqual(
      {
        isOpen: false,
        activeSurfaceId: null,
        surfaces: [],
      },
    );
  });

  it("can hide a panel without dropping its tabs", () => {
    useRightPanelStore.getState().open(THREAD_A, "diff");
    useRightPanelStore.getState().openFile(THREAD_A, { relativePath: "src/app.ts" });

    useRightPanelStore.getState().close(THREAD_A);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A)).toEqual(
      {
        isOpen: false,
        activeSurfaceId: "file:src/app.ts",
        surfaces: [
          { id: "diff", kind: "diff" },
          { id: "file:src/app.ts", kind: "file", relativePath: "src/app.ts" },
        ],
      },
    );
  });

  it("removes all state for a deleted thread", () => {
    useRightPanelStore.getState().open(THREAD_A, "diff");
    useRightPanelStore.getState().open(THREAD_B, "plan");

    useRightPanelStore.getState().removeThread(THREAD_A);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A)).toEqual(
      {
        isOpen: false,
        activeSurfaceId: null,
        surfaces: [],
      },
    );
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_B)).toEqual(
      {
        isOpen: true,
        activeSurfaceId: "plan",
        surfaces: [{ id: "plan", kind: "plan" }],
      },
    );
  });

  it("keeps thread state isolated", () => {
    useRightPanelStore.getState().open(THREAD_A, "diff");
    useRightPanelStore.getState().open(THREAD_B, "plan");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_A)).toEqual(
      {
        isOpen: true,
        activeSurfaceId: "diff",
        surfaces: [{ id: "diff", kind: "diff" }],
      },
    );
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadId, THREAD_B)).toEqual(
      {
        isOpen: true,
        activeSurfaceId: "plan",
        surfaces: [{ id: "plan", kind: "plan" }],
      },
    );
  });
});
