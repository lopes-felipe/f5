import "../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ReactNode } from "react";
import FileViewPanel from "./FileViewPanel";
import { providerQueryKeys } from "../lib/providerReactQuery";

const api = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => ({ projects: api }),
  readNativeApi: () => ({ projects: api }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: ({ select }: { select: (v: unknown) => unknown }) => select({ threadId: "thread-1" }),
  useSearch: ({ select }: { select: (v: unknown) => unknown }) =>
    select({ fileViewPath: "app.ts" }),
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
afterEach(() => vi.clearAllMocks());

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
      expect.objectContaining({ contents: "merged edit", expectedContentSha256: "agent-hash" }),
    );
  } finally {
    await screen.unmount();
    client.clear();
  }
});
