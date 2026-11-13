import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { DesktopAppActivationCoordinator } from "./DesktopAppActivationCoordinator";
const state = vi.hoisted(() => ({
  ready: true,
  projects: [] as { id: string; cwd: string }[],
  requests: [] as { id: string; path: string }[],
  snapshot: vi.fn(async () => ({ snapshot: {} })),
  dispatch: vi.fn(),
  start: vi.fn(async () => ({ threadId: "new" })),
  complete: vi.fn(),
}));
vi.mock("../lib/startupReady", () => ({ useStartupReady: () => state.ready }));
vi.mock("../hooks/useCreateProjectBackedDraftThread", () => ({
  useCreateProjectBackedDraftThread: () => state.start,
}));
vi.mock("../store", () => ({
  useStore: {
    getState: () => ({
      projects: state.projects,
      syncStartupSnapshot: () => {},
      setProjectExpanded: () => {},
    }),
  },
}));
vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => ({
    orchestration: {
      getStartupSnapshot: (...args: unknown[]) => state.snapshot(...(args as [])),
      dispatchCommand: (command: { projectId: string; workspaceRoot: string }) => {
        state.dispatch(command);
        state.projects.push({ id: command.projectId, cwd: command.workspaceRoot });
        return Promise.resolve();
      },
    },
  }),
}));
const previousBridge = window.desktopBridge;
afterEach(() => {
  Object.defineProperty(window, "desktopBridge", { value: previousBridge, configurable: true });
  state.ready = true;
  state.projects = [];
  state.requests = [];
  state.snapshot.mockReset().mockResolvedValue({ snapshot: {} });
  state.start.mockReset().mockResolvedValue({ threadId: "new" });
  vi.clearAllMocks();
});
function bridge() {
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      takeAppActivations: async () => [...state.requests],
      onAppActivationsAvailable: () => () => {},
      completeAppActivation: async (id: string, error?: string) => {
        state.complete(id, error);
        state.requests = state.requests.filter((request) => request.id !== id);
      },
    },
  });
}
it.each([false, true])(
  "acknowledges an activation using an existing project: %s",
  async (existing) => {
    state.requests = [{ id: "request", path: "/repo" }];
    if (existing) state.projects = [{ id: "existing", cwd: "/repo" }];
    bridge();
    const view = await render(<DesktopAppActivationCoordinator />);
    try {
      await vi.waitFor(() => expect(state.complete).toHaveBeenCalledWith("request", undefined));
      expect(state.start).toHaveBeenCalledOnce();
      expect(state.dispatch).toHaveBeenCalledTimes(existing ? 0 : 1);
      if (existing) expect(state.start).toHaveBeenCalledWith("existing");
    } finally {
      await view.unmount();
    }
  },
);
it("reports failures to the CLI", async () => {
  state.requests = [{ id: "request", path: "/repo" }];
  state.start.mockRejectedValueOnce(new Error("Draft failed"));
  bridge();
  const view = await render(<DesktopAppActivationCoordinator />);
  try {
    await vi.waitFor(() => expect(state.complete).toHaveBeenCalledWith("request", "Draft failed"));
  } finally {
    await view.unmount();
  }
});
it("drains new activations after an effect is replaced during an in-flight read", async () => {
  let release!: (value: { snapshot: object }) => void;
  state.snapshot.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  state.requests = [{ id: "old", path: "/old" }];
  bridge();
  const view = await render(<DesktopAppActivationCoordinator />);
  try {
    await vi.waitFor(() => expect(state.snapshot).toHaveBeenCalledOnce());
    state.ready = false;
    await view.rerender(<DesktopAppActivationCoordinator />);
    state.ready = true;
    await view.rerender(<DesktopAppActivationCoordinator />);
    state.requests.push({ id: "new", path: "/new" });
    release({ snapshot: {} });
    await vi.waitFor(() => expect(state.complete).toHaveBeenCalledWith("new", undefined));
    expect(state.complete).toHaveBeenCalledWith("old", "The desktop window was closed.");
    expect(state.dispatch).toHaveBeenCalledOnce();
  } finally {
    await view.unmount();
  }
});
