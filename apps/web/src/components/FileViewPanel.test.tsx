import FileViewPanel from "./FileViewPanel";
import { renderToStaticMarkup } from "react-dom/server";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockedValues = vi.hoisted(() => ({
  navigate: vi.fn(),
  capturedButtons: [] as Array<ButtonHTMLAttributes<HTMLButtonElement>>,
  draftThreadsByThreadId: {} as Record<string, { projectId: string; worktreePath: string | null }>,
}));

let searchState: Record<string, unknown> = {
  diff: "1",
  fileViewPath: "src/app.ts",
  fileLine: 42,
  fileEndLine: 44,
  fileColumn: 7,
};

const useQueryMock = vi.fn();
let storeState = {
  threads: [{ id: "thread-1", projectId: "project-1", worktreePath: "/repo/project" }],
  projects: [{ id: "project-1", cwd: "/repo/project" }],
};

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockedValues.navigate,
  useParams: ({ select }: { select: (params: { threadId: string }) => unknown }) =>
    select({ threadId: "thread-1" }),
  useSearch: ({ select }: { select: (search: Record<string, unknown>) => unknown }) =>
    select(searchState),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (input: unknown) => useQueryMock(input),
  useQueryClient: () => ({ setQueryData: vi.fn() }),
  queryOptions: (input: unknown) => input,
}));

vi.mock("../store", () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (
    selector: (state: {
      draftThreadsByThreadId: typeof mockedValues.draftThreadsByThreadId;
    }) => unknown,
  ) => selector({ draftThreadsByThreadId: mockedValues.draftThreadsByThreadId }),
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("./DiffPanelShell", () => ({
  DiffPanelShell: ({ header, children }: { header: ReactNode; children: ReactNode }) => (
    <div>
      <div>{header}</div>
      <div>{children}</div>
    </div>
  ),
  DiffPanelLoadingState: ({ label }: { label: string }) => <div>{label}</div>,
}));

vi.mock("./ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => {
    mockedValues.capturedButtons.push(props);
    return (
      <button type="button" {...props}>
        {children}
      </button>
    );
  },
}));

vi.mock("./DiffPanel", () => ({
  DIFF_PANEL_UNSAFE_CSS: "",
}));

vi.mock("@pierre/diffs/react", () => ({
  File: ({
    file,
    selectedLines,
  }: {
    file: { name: string; contents: string };
    selectedLines?: { start: number; end: number } | null;
  }) => (
    <div data-selected-lines={selectedLines ? `${selectedLines.start}-${selectedLines.end}` : ""}>
      {file.name}:{file.contents}
    </div>
  ),
}));

describe("FileViewPanel", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    mockedValues.navigate.mockReset();
    mockedValues.capturedButtons.length = 0;
    mockedValues.draftThreadsByThreadId = {};
    storeState = {
      threads: [{ id: "thread-1", projectId: "project-1", worktreePath: "/repo/project" }],
      projects: [{ id: "project-1", cwd: "/repo/project" }],
    };
    searchState = {
      diff: "1",
      fileViewPath: "src/app.ts",
      fileLine: 42,
      fileEndLine: 44,
      fileColumn: 7,
    };
  });

  async function renderPanel() {
    return renderToStaticMarkup(<FileViewPanel mode="sheet" />);
  }

  it("renders the loading state", async () => {
    useQueryMock.mockReturnValue({
      isLoading: true,
      isError: false,
      data: undefined,
      refetch: vi.fn(),
    });

    const markup = await renderPanel();

    expect(markup).toContain("Loading file...");
  });

  it("preserves the diff selection when the file view is dismissed", async () => {
    useQueryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: {
        relativePath: "src/app.ts",
        contents: "export const value = 1;\n",
      },
      refetch: vi.fn(),
    });

    await renderPanel();

    const closeButtonProps = mockedValues.capturedButtons.find(
      (props) => props["aria-label"] === "Close file view",
    );
    expect(closeButtonProps?.onClick).toBeTypeOf("function");

    closeButtonProps?.onClick?.({} as never);

    expect(mockedValues.navigate).toHaveBeenCalledTimes(1);
    const navigateCall = mockedValues.navigate.mock.calls[0]?.[0];
    expect(navigateCall).toMatchObject({
      to: "/$threadId",
      params: { threadId: "thread-1" },
    });
    expect(
      navigateCall.search({
        diff: "1",
        diffTurnId: "turn-1",
        diffFilePath: "src/diff.ts",
        fileViewPath: "src/app.ts",
        fileLine: 42,
        fileEndLine: 44,
        fileColumn: 7,
        preserveMe: "ok",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/diff.ts",
      fileViewPath: undefined,
      fileLine: undefined,
      fileEndLine: undefined,
      fileColumn: undefined,
      preserveMe: "ok",
    });
  });

  it("renders retry and open-in-editor actions for errors", async () => {
    useQueryMock.mockReturnValue({
      isLoading: false,
      isError: true,
      error: new Error("Unable to read src/app.ts"),
      data: undefined,
      refetch: vi.fn(),
    });

    const markup = await renderPanel();

    expect(markup).toContain("Unable to read src/app.ts");
    expect(markup).toContain("Retry");
    expect(markup).toContain("Open in preferred editor");
  });

  it("hands binary files to the media viewer instead of the text error", async () => {
    useQueryMock.mockReturnValue({
      isLoading: false,
      isError: true,
      error: new Error("Binary file cannot be displayed: src/app.ts"),
      data: undefined,
      refetch: vi.fn(),
    });

    const markup = await renderPanel();

    // The shared query mock also fails the asset grant, so the media view's own error shows.
    expect(markup).toContain("Unable to open this file.");
    expect(markup).not.toContain("Binary file cannot be displayed");
  });

  it("reads external files from their own directory and disables editing", async () => {
    searchState = { fileViewPath: "/tmp/natura-imagens-categorias/imagens.json" };
    useQueryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { contents: '{"images":8}', contentSha256: "hash", truncated: false },
    });

    const markup = await renderPanel();

    expect(useQueryMock.mock.calls[0]?.[0]).toMatchObject({
      queryKey: ["fileContent", "/tmp/natura-imagens-categorias", "imagens.json"],
      enabled: true,
    });
    expect(markup).toContain("Read-only preview");
    expect(markup).toContain("images");
    expect(
      mockedValues.capturedButtons.find((props) => props["aria-label"] === "Edit file")?.disabled,
    ).toBe(true);
  });

  it.each([
    "File not found: report.json",
    "Permission denied: report.json",
    "Binary file cannot be displayed: report.json",
  ])("shows external read failures instead of using workspace media: %s", async (message) => {
    searchState = { fileViewPath: "/tmp/export/report.json" };
    useQueryMock.mockReturnValue({ isLoading: false, isError: true, error: new Error(message) });
    const markup = await renderPanel();
    expect(markup).toContain("Unable to display file");
    expect(markup).toContain(message);
    expect(markup).toContain("/tmp/export/report.json");
    expect(markup).toContain("Retry");
  });

  it("renders the file contents and selected line range", async () => {
    useQueryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: {
        relativePath: "src/app.ts",
        contents: "export const value = 1;\n",
      },
      refetch: vi.fn(),
    });

    const markup = await renderPanel();

    expect(markup).toContain("app.ts");
    expect(markup).toContain("L42:7");
    expect(markup).toContain("src/app.ts:export const value = 1;");
    expect(markup).toContain('data-selected-lines="42-44"');
    expect(markup).toContain("file-view-surface");
  });

  it("reads file contents from the draft project before the thread is persisted", async () => {
    storeState = {
      threads: [],
      projects: [{ id: "project-1", cwd: "/repo/project" }],
    };
    mockedValues.draftThreadsByThreadId = {
      "thread-1": {
        projectId: "project-1",
        worktreePath: null,
      },
    };
    useQueryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: {
        relativePath: "src/app.ts",
        contents: "export const draft = true;\n",
      },
      refetch: vi.fn(),
    });

    const markup = await renderPanel();

    expect(useQueryMock.mock.calls[0]?.[0]).toMatchObject({
      queryKey: ["fileContent", "/repo/project", "src/app.ts"],
      enabled: true,
    });
    expect(markup).toContain("src/app.ts:export const draft = true;");
    expect(markup).not.toContain("File contents are unavailable.");
  });

  it("preserves line and column in the editor handoff target", async () => {
    const { resolveEditorTarget } = await import("./FileViewPanel");

    expect(
      resolveEditorTarget({
        filePath: "src/app.ts",
        workspaceRoot: "/repo/project",
        line: 42,
        column: 7,
      }),
    ).toBe("/repo/project/src/app.ts:42:7");
  });

  it("keeps newer local edits when an older saved snapshot reaches the cache", async () => {
    const { reconcileDraftContents } = await import("./FileViewPanel");

    expect(
      reconcileDraftContents({
        currentDraft: "saved snapshot\nnew unsaved line\n",
        incomingContents: "saved snapshot\n",
        editing: true,
      }),
    ).toBe("saved snapshot\nnew unsaved line\n");
    expect(
      reconcileDraftContents({
        currentDraft: "stale draft",
        incomingContents: "reloaded contents",
        editing: false,
      }),
    ).toBe("reloaded contents");
  });
});
