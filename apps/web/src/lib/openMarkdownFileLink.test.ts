import { beforeEach, expect, it, vi } from "vitest";
import { resolveMarkdownFileLinkMeta } from "../markdown-links";
import { openMarkdownFileLink } from "./openMarkdownFileLink";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  list: vi.fn(),
  open: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../editorPreferences", () => ({
  withEditorOpenAuthorization: async (_path: unknown, work: (token: string) => Promise<void>) => {
    mocks.prepare();
    return work("captured-grant");
  },
  resolveAndPersistPreferredEditor: () => "cursor",
}));
vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    projects: { listDirectory: mocks.list },
    shell: { openInEditor: mocks.open },
    server: { getConfig: async () => ({ availableEditors: ["cursor"] }) },
  }),
}));
vi.mock("./workspaceBasename", () => ({ findWorkspaceBasenameFile: async () => null }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.navigate.mockReturnValue(true);
  mocks.list.mockImplementation(async () => {
    expect(mocks.prepare).toHaveBeenCalledOnce();
    return { entries: [] };
  });
});

it.each(["Makefile", "Dockerfile", "LICENSE", ".gitignore", ".env"])(
  "keeps %s in the file viewer",
  async (name) => {
    const meta = resolveMarkdownFileLinkMeta("file:///repo/" + name)!;
    await openMarkdownFileLink(meta, "/repo", mocks.navigate);
    expect(mocks.navigate).toHaveBeenCalledWith("/repo/" + name);
    expect(mocks.open).not.toHaveBeenCalled();
  },
);
it.each(["/repo/src", "/repo/.github"])(
  "opens a reported directory in VS Code: %s",
  async (path) => {
    mocks.list.mockResolvedValue({ entries: [{ path, kind: "directory" }] });
    await openMarkdownFileLink(
      resolveMarkdownFileLinkMeta("file://" + path)!,
      "/repo",
      mocks.navigate,
    );
    expect(mocks.open).toHaveBeenCalledWith(path, "vscode", "captured-grant");
    expect(mocks.navigate).not.toHaveBeenCalled();
  },
);
it("preserves line navigation and the preferred editor when the viewer declines", async () => {
  mocks.navigate.mockReturnValue(false);
  await openMarkdownFileLink(
    resolveMarkdownFileLinkMeta("file:///repo/Makefile:7:2")!,
    "/repo",
    mocks.navigate,
  );
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.open).toHaveBeenCalledWith("/repo/Makefile:7:2", "cursor", "captured-grant");
});

it("keeps the failed editor target in the visible error", async () => {
  mocks.navigate.mockReturnValue(false);
  mocks.open.mockRejectedValue(new Error("Editor launch failed"));
  await openMarkdownFileLink(
    resolveMarkdownFileLinkMeta("file:///tmp/export/report.json")!,
    "/repo",
    mocks.navigate,
  );
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      description: "/tmp/export/report.json: Editor launch failed",
    }),
  );
});
