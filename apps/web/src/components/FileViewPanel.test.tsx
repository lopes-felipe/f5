import { renderToStaticMarkup } from "react-dom/server";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockedValues = vi.hoisted(() => ({
  navigate: vi.fn(),
  capturedButtons: [] as Array<ButtonHTMLAttributes<HTMLButtonElement>>,
}));

let searchState: Record<string, unknown> = {
  diff: "1",
  fileViewPath: "src/app.ts",
  fileLine: 42,
  fileEndLine: 44,
  fileColumn: 7,
};

const useQueryMock = vi.fn();
const storeState = {
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
  queryOptions: (input: unknown) => input,
}));

vi.mock("../store", () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
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
    searchState = {
      diff: "1",
      fileViewPath: "src/app.ts",
      fileLine: 42,
      fileEndLine: 44,
      fileColumn: 7,
    };
  });

  async function renderPanel() {
    const { default: FileViewPanel } = await import("./FileViewPanel");
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
      error: new Error("Binary file cannot be displayed: src/app.ts"),
      data: undefined,
      refetch: vi.fn(),
    });

    const markup = await renderPanel();

    expect(markup).toContain("Binary file cannot be displayed: src/app.ts");
    expect(markup).toContain("Retry");
    expect(markup).toContain("Open in editor");
  });

  it("shows an editor-only message for files outside the workspace", async () => {
    searchState = {
      diff: "1",
      fileViewPath: "/tmp/f3-code-random-snippet-91ddf119.ts",
    };
    useQueryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: undefined,
      refetch: vi.fn(),
    });

    const markup = await renderPanel();

    expect(markup).toContain("Unable to display file");
    expect(markup).toContain(
      "Files outside the current workspace can only be opened in your editor.",
    );
    expect(markup).toContain("Open in editor");
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
});
