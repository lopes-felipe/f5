import { noteWsConnectionOpened, noteWsSynchronized } from "../wsConnectionState";
import "../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ReactNode } from "react";
import FileViewPanel from "./FileViewPanel";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { resetWorkspaceWatchForTests, startWorkspaceWatchSync } from "../lib/workspaceWatch";
import type { ProjectWatchedPathsChangedPayload } from "@t3tools/contracts";

const route = vi.hoisted(() => ({ fileViewPath: "app.ts" }));
const api = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  setWatchedPaths: vi.fn(),
  onWatchedPathsChanged: vi.fn(),
  openInEditor: vi.fn(),
  revealInFileManager: vi.fn(),
  getConfig: vi.fn(),
}));
vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => ({ projects: api, shell: api, server: api }),
  readNativeApi: () => ({ projects: api, shell: api, server: api }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => null,
  useParams: ({ select }: { select: (v: unknown) => unknown }) => select({ threadId: "thread-1" }),
  useSearch: ({ select }: { select: (v: unknown) => unknown }) => select(route),
}));
vi.mock("../store", () => ({
  useStore: (select: (v: unknown) => unknown) =>
    select({
      threads: [{ id: "thread-1", projectId: "project-1", worktreePath: "/repo" }],
      projects: [{ id: "project-1", cwd: "/repo" }],
    }),
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (v: unknown) => unknown) =>
    select({ draftThreadsByThreadId: {} }),
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("./DiffPanel", () => ({ DIFF_PANEL_UNSAFE_CSS: "" }));
vi.mock("./DiffPanelShell", () => ({
  DiffPanelShell: ({ header, children }: { header: ReactNode; children: ReactNode }) => (
    <div>
      {header}
      {children}
    </div>
  ),
  DiffPanelLoadingState: () => <div>Loading</div>,
}));
vi.mock("@pierre/diffs/react", () => ({ File: () => <div>Rendered file</div> }));
beforeEach(() => {
  noteWsConnectionOpened();
  noteWsSynchronized();
});

it.each([
  ["src/app.ts", "/repo/src/app.ts", "/repo", "src/app.ts"],
  ["/tmp/external/report.json", "/tmp/external/report.json", "/tmp/external", "report.json"],
])(
  "opens %s in VS Code and reveals the actual file",
  async (file, absolutePath, cwd, relativePath) => {
    route.fileViewPath = file;
    api.readFile.mockResolvedValue({
      relativePath,
      contents: "{}",
      byteLength: 2,
      truncated: false,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={client}>
        <FileViewPanel mode="sheet" />
      </QueryClientProvider>,
    );
    try {
      await screen.getByRole("button", { name: "Open in VS Code", exact: true }).click();
      await expect.poll(() => api.openInEditor.mock.calls).toEqual([[absolutePath, "vscode"]]);
      await screen.getByRole("button", { name: "Reveal in file manager", exact: true }).click();
      await expect
        .poll(() => api.revealInFileManager.mock.calls)
        .toEqual([
          [
            {
              projectId: "project-1",
              threadId: "thread-1",
              ...(file.startsWith("/") ? { cwd } : {}),
              relativePath,
              kind: "file",
            },
          ],
        ]);
    } finally {
      await screen.unmount();
      client.clear();
    }
  },
);
afterEach(() => {
  vi.clearAllMocks();
  route.fileViewPath = "app.ts";
  localStorage.removeItem("t3code:last-editor");
});

it("uses the configured preferred editor while retaining an explicit VS Code action", async () => {
  localStorage.setItem("t3code:last-editor", JSON.stringify("zed"));
  api.getConfig.mockResolvedValue({ availableEditors: ["vscode", "zed"] });
  api.readFile.mockResolvedValue({
    relativePath: "app.ts",
    contents: "{}",
    byteLength: 2,
    truncated: false,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={client}>
      <FileViewPanel mode="sheet" />
    </QueryClientProvider>,
  );
  try {
    await screen.getByRole("button", { name: "Open in preferred editor", exact: true }).click();
    await expect.poll(() => api.openInEditor.mock.calls).toEqual([["/repo/app.ts", "zed"]]);
    await expect
      .element(screen.getByRole("button", { name: "Open in VS Code", exact: true }))
      .toBeVisible();
  } finally {
    await screen.unmount();
    client.clear();
  }
});

it("preserves the draft base and blocks saves when a refetch arrives during editing", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = providerQueryKeys.fileContent({ cwd: "/repo", relativePath: "app.ts" });
  const original = {
    relativePath: "app.ts",
    contents: "original",
    byteLength: 8,
    truncated: false,
    contentSha256: "old-hash",
  };
  api.readFile.mockResolvedValue(original);
  client.setQueryData(key, original);
  const screen = await render(
    <QueryClientProvider client={client}>
      <FileViewPanel mode="sheet" />
    </QueryClientProvider>,
  );
  try {
    await screen.getByRole("button", { name: "Edit file", exact: true }).click();
    await screen.getByRole("textbox", { name: "File source editor" }).fill("my unsaved draft");
    const updated = { ...original, contents: "agent edit", contentSha256: "agent-hash" };
    client.setQueryData(key, updated);
    await expect
      .element(screen.getByText("File changed outside this editor", { exact: true }))
      .toBeVisible();
    await expect.element(screen.getByRole("textbox")).toHaveValue("my unsaved draft");
    await expect
      .element(screen.getByRole("button", { name: "Save file", exact: true }))
      .toBeDisabled();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(api.writeFile).not.toHaveBeenCalled();
    client.setQueryData(key, { ...updated });
    await expect
      .element(screen.getByText("File changed outside this editor", { exact: true }))
      .toBeVisible();
    api.readFile.mockResolvedValue(updated);
    await screen.getByRole("button", { name: "Reload", exact: true }).click();
    await screen.getByRole("button", { name: "Edit file", exact: true }).click();
    await expect.element(screen.getByRole("textbox")).toHaveValue("agent edit");
    api.writeFile.mockResolvedValue({
      relativePath: "app.ts",
      contentSha256: "saved-hash",
      byteLength: 7,
    });
    await screen.getByRole("textbox").fill("merged edit");
    await screen.getByRole("button", { name: "Save file", exact: true }).click();
    expect(api.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: "merged edit",
        condition: { type: "match", contentSha256: "agent-hash" },
      }),
    );
  } finally {
    await screen.unmount();
    client.clear();
  }
});

it("ignores a save response from an earlier visit to the same file", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const file = (relativePath: string, contents: string) => ({
    relativePath,
    contents,
    byteLength: contents.length,
    truncated: false,
    contentSha256: `${relativePath}-${contents}`,
  });
  api.readFile.mockImplementation(({ relativePath }: { relativePath: string }) =>
    Promise.resolve(file(relativePath, "fresh")),
  );
  let finish!: (result: unknown) => void;
  api.writeFile.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = () => (
    <QueryClientProvider client={client}>
      <FileViewPanel mode="sheet" />
    </QueryClientProvider>
  );
  const screen = await render(view());
  try {
    await screen.getByRole("button", { name: "Edit file", exact: true }).click();
    await screen.getByRole("textbox").fill("first visit");
    await screen.getByRole("button", { name: "Save file", exact: true }).click();
    await expect.poll(() => api.writeFile.mock.calls.length).toBe(1);
    route.fileViewPath = "other.ts";
    await screen.rerender(view());
    await screen.getByRole("button", { name: "Edit file", exact: true }).click();
    await expect.element(screen.getByRole("textbox")).toHaveValue("fresh");
    route.fileViewPath = "app.ts";
    await screen.rerender(view());
    await screen.getByRole("button", { name: "Edit file", exact: true }).click();
    await screen.getByRole("textbox").fill("new visit draft");
    finish({ relativePath: "app.ts", contentSha256: "obsolete-response", byteLength: 11 });
    await expect.element(screen.getByRole("textbox")).toHaveValue("new visit draft");
    await expect
      .poll(
        () =>
          client.getQueryData<{ contentSha256: string }>(
            providerQueryKeys.fileContent({ cwd: "/repo", relativePath: "app.ts" }),
          )?.contentSha256,
      )
      .not.toBe("obsolete-response");
  } finally {
    await screen.unmount();
    client.clear();
  }
});

it("keeps canonical draft identity after save and recovers edits typed afterward", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  route.fileViewPath = "stable-key.ts";
  const key = providerQueryKeys.fileContent({ cwd: "/repo", relativePath: route.fileViewPath });
  const original = {
    relativePath: route.fileViewPath,
    workspaceIdentity: "/canonical/repo",
    fileIdentity: "/canonical/repo/stable-key.ts",
    contents: "base",
    byteLength: 4,
    truncated: false,
    contentSha256: "base-hash",
  };
  api.readFile.mockResolvedValue(original);
  api.writeFile.mockResolvedValue({
    relativePath: route.fileViewPath,
    byteLength: 5,
    contentSha256: "saved-hash",
  });
  client.setQueryData(key, original);
  const view = () => (
    <QueryClientProvider client={client}>
      <FileViewPanel mode="sheet" />
    </QueryClientProvider>
  );
  let screen = await render(view());
  try {
    await screen.getByRole("button", { name: "Edit file", exact: true }).click();
    await screen.getByRole("textbox").fill("saved");
    await screen.getByRole("button", { name: "Save file", exact: true }).click();
    await expect
      .poll(() => client.getQueryData(key))
      .toEqual(
        expect.objectContaining({
          ...original,
          contents: "saved",
          byteLength: 5,
          contentSha256: "saved-hash",
        }),
      );
    await screen.getByRole("textbox").fill("recover after save");
    await expect
      .poll(async () => {
        const { editorDrafts, editorFileKey } = await import("../editorDrafts");
        return (
          await editorDrafts.list(
            editorFileKey("default", original.workspaceIdentity, original.fileIdentity),
          )
        ).some((draft) => draft.text === "recover after save");
      })
      .toBe(true);
    await screen.unmount();
    api.readFile.mockResolvedValue({ ...original, contents: "saved", contentSha256: "saved-hash" });
    screen = await render(view());
    await screen.getByRole("button", { name: "Recover", exact: true }).click();
    await expect.element(screen.getByRole("textbox")).toHaveValue("recover after save");
  } finally {
    await screen.unmount();
    client.clear();
  }
});

it("watches the open file and turns an external edit into a conflict for a dirty draft", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const original = {
    relativePath: "app.ts",
    contents: "original",
    byteLength: 8,
    truncated: false,
    contentSha256: "old-hash",
  };
  const external = { ...original, contents: "external edit", contentSha256: "external-hash" };
  let pushChange: ((payload: ProjectWatchedPathsChangedPayload) => void) | undefined;
  api.onWatchedPathsChanged.mockImplementation(
    (listener: (payload: ProjectWatchedPathsChangedPayload) => void) => {
      pushChange = listener;
      return () => undefined;
    },
  );
  api.setWatchedPaths.mockResolvedValue({ watched: 1, degraded: false, rejected: [] });
  api.readFile.mockResolvedValue(original);
  const stopWatching = startWorkspaceWatchSync(client);
  const screen = await render(
    <QueryClientProvider client={client}>
      <FileViewPanel mode="sheet" />
    </QueryClientProvider>,
  );
  try {
    await vi.waitFor(() =>
      expect(api.setWatchedPaths).toHaveBeenCalledWith({
        cwd: "/repo",
        files: ["app.ts"],
        directories: [],
      }),
    );
    await screen.getByRole("button", { name: "Edit file", exact: true }).click();
    await screen.getByRole("textbox", { name: "File source editor" }).fill("my unsaved draft");
    const readsBefore = api.readFile.mock.calls.length;

    api.readFile.mockResolvedValue(external);
    pushChange!({
      cwd: "/repo",
      changes: [{ relativePath: "app.ts", kind: "file", change: "changed", revision: 1 }],
      degraded: false,
    });

    await vi.waitFor(() => expect(api.readFile.mock.calls.length).toBeGreaterThan(readsBefore));
    await expect
      .element(screen.getByText("File changed outside this editor", { exact: true }))
      .toBeVisible();
    await expect.element(screen.getByRole("textbox")).toHaveValue("my unsaved draft");
  } finally {
    await screen.unmount();
    stopWatching();
    resetWorkspaceWatchForTests();
    client.clear();
  }
});

it.each([
  ["src/missing.ts", "/repo", "src/missing.ts", "in workspace folder /repo"],
  ["/tmp/export/missing.json", "/tmp/export", "missing.json", "in folder /tmp/export"],
])(
  "shows the actual read directory when %s cannot be read",
  async (file, cwd, relativePath, folder) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    route.fileViewPath = file;
    api.setWatchedPaths.mockResolvedValue({ watched: 1, degraded: false, rejected: [] });
    api.onWatchedPathsChanged.mockReturnValue(() => undefined);
    api.readFile.mockRejectedValue(new Error("File not found."));
    const screen = await render(
      <QueryClientProvider client={client}>
        <FileViewPanel mode="sheet" />
      </QueryClientProvider>,
    );
    try {
      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("File not found.");
        expect(text).toContain(`Attempted path ${relativePath} ${folder}`);
        if (file.startsWith("/")) expect(text).not.toContain("in workspace folder /repo");
      });
      expect(api.readFile).toHaveBeenCalledWith({ cwd, relativePath });
    } finally {
      await screen.unmount();
      client.clear();
    }
  },
);
