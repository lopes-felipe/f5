import "../index.css";

import type { NativeApi, ProjectEntry, ProjectListEntriesResult } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import FileBrowserPanel from "./FileBrowserPanel";

const { nativeApiRef } = vi.hoisted(() => ({
  nativeApiRef: {
    current: undefined as NativeApi | undefined,
  },
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => {
    if (!nativeApiRef.current) {
      throw new Error("Native API not found");
    }
    return nativeApiRef.current;
  },
}));

const listEntries = vi.fn();
const searchEntries = vi.fn();

const TREE_ENTRIES: ProjectEntry[] = [
  { path: "src", kind: "directory" },
  { path: "src/components", kind: "directory", parentPath: "src" },
  { path: "src/components/FileBrowserPanel.tsx", kind: "file", parentPath: "src/components" },
  { path: "src/App.tsx", kind: "file", parentPath: "src" },
  { path: "README.md", kind: "file" },
];

function listResult(entries: ProjectEntry[] = TREE_ENTRIES): ProjectListEntriesResult {
  return {
    entries,
    truncated: false,
    totalEntries: entries.length,
  };
}

async function renderPanel(options: { entryLimit?: number } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const onOpenFile = vi.fn();
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <FileBrowserPanel
        cwd="/repo/project"
        projectName="Project"
        entryLimit={options.entryLimit ?? 5_000}
        onOpenFile={onOpenFile}
      />
    </QueryClientProvider>,
  );
  return {
    onOpenFile,
    cleanup: async () => {
      await screen.unmount();
      queryClient.clear();
    },
  };
}

async function pressSearchInputKey(key: string) {
  await page.getByPlaceholder("Search files").click();
  await userEvent.keyboard(`{${key}}`);
}

function dispatchSearchInputKeyDown(key: string) {
  page
    .getByPlaceholder("Search files")
    .element()
    .dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }),
    );
}

async function searchFor(query: string) {
  await page.getByPlaceholder("Search files").fill(query);
  await vi.waitFor(
    () => {
      expect(searchEntries).toHaveBeenCalledWith({
        cwd: "/repo/project",
        query,
        limit: 100,
      });
    },
    { timeout: 3_000, interval: 16 },
  );
}

describe("FileBrowserPanel", () => {
  beforeEach(() => {
    listEntries.mockResolvedValue(listResult());
    searchEntries.mockResolvedValue({ entries: [], truncated: false });
    nativeApiRef.current = {
      projects: {
        listEntries,
        searchEntries,
      },
    } as unknown as NativeApi;
  });

  afterEach(() => {
    nativeApiRef.current = undefined;
    listEntries.mockReset();
    searchEntries.mockReset();
    document.body.innerHTML = "";
  });

  it("renders tree entries from projects.listEntries while the query is empty", async () => {
    const mounted = await renderPanel();
    try {
      await expect.element(page.getByText("src")).toBeInTheDocument();
      await expect.element(page.getByText("App.tsx")).toBeInTheDocument();

      expect(listEntries).toHaveBeenCalledWith({ cwd: "/repo/project", limit: 5_000 });
      expect(searchEntries).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("passes the configured tree entry limit to projects.listEntries", async () => {
    const mounted = await renderPanel({ entryLimit: 100_000 });
    try {
      await expect.element(page.getByText("src")).toBeInTheDocument();

      expect(listEntries).toHaveBeenCalledWith({ cwd: "/repo/project", limit: 100_000 });
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses projects.searchEntries for non-empty search and renders flat ranked results", async () => {
    searchEntries.mockImplementation(async ({ query }: { query: string }) =>
      query === "fuzzy"
        ? {
            entries: [
              { path: "packages/contracts/src/project.ts", kind: "file" },
              { path: "apps/web/src/components", kind: "directory" },
            ],
            truncated: true,
          }
        : { entries: [], truncated: false },
    );
    const mounted = await renderPanel();
    try {
      await searchFor("fuzzy");

      const bodyText = document.body.textContent ?? "";
      expect(bodyText.indexOf("project.ts")).toBeLessThan(bodyText.indexOf("components"));
      await expect.element(page.getByText("packages/contracts/src/project.ts")).toBeInTheDocument();
      await expect
        .element(page.getByText("More matches available. Refine your search."))
        .toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens file search results directly", async () => {
    searchEntries.mockResolvedValue({
      entries: [{ path: "src/components/FileBrowserPanel.tsx", kind: "file" }],
      truncated: false,
    });
    const mounted = await renderPanel();
    try {
      await searchFor("panel");
      await page.getByRole("button", { name: /FileBrowserPanel\.tsx/ }).click();

      expect(mounted.onOpenFile).toHaveBeenCalledWith("src/components/FileBrowserPanel.tsx");
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens a file result with Enter", async () => {
    searchEntries.mockResolvedValue({
      entries: [{ path: "README.md", kind: "file" }],
      truncated: false,
    });
    const mounted = await renderPanel();
    try {
      await searchFor("readme");
      await expect.element(page.getByRole("button", { name: /README\.md/ })).toBeInTheDocument();
      await pressSearchInputKey("Enter");

      await vi.waitFor(() => {
        expect(mounted.onOpenFile).toHaveBeenCalledWith("README.md");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("reveals the highlighted directory with Enter", async () => {
    searchEntries.mockResolvedValue({
      entries: [
        { path: "src/components", kind: "directory" },
        { path: "README.md", kind: "file" },
      ],
      truncated: false,
    });
    const mounted = await renderPanel();
    try {
      await searchFor("components");
      await expect.element(page.getByRole("button", { name: /components/ })).toBeInTheDocument();
      dispatchSearchInputKeyDown("ArrowDown");
      await vi.waitFor(() => {
        expect(
          page
            .getByRole("button", { name: /components/ })
            .element()
            .getAttribute("aria-selected"),
        ).toBe("true");
      });

      await pressSearchInputKey("Enter");

      await vi.waitFor(() => {
        expect((page.getByPlaceholder("Search files").element() as HTMLInputElement).value).toBe(
          "",
        );
      });
      await expect.element(page.getByText("FileBrowserPanel.tsx")).toBeInTheDocument();
      expect(mounted.onOpenFile).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides stale search results while the typed query is waiting for debounce", async () => {
    searchEntries.mockImplementation(async ({ query }: { query: string }) =>
      query === "old"
        ? {
            entries: [{ path: "docs/OldResult.md", kind: "file" }],
            truncated: false,
          }
        : {
            entries: [{ path: "docs/NewResult.md", kind: "file" }],
            truncated: false,
          },
    );
    const mounted = await renderPanel();
    try {
      await searchFor("old");
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("OldResult.md");
      });

      await page.getByPlaceholder("Search files").fill("new");

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").not.toContain("OldResult.md");
      });
      await searchFor("new");
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("NewResult.md");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("clears search on Escape and returns to tree mode", async () => {
    searchEntries.mockResolvedValue({
      entries: [{ path: "docs/OnlySearchResult.md", kind: "file" }],
      truncated: false,
    });
    const mounted = await renderPanel();
    try {
      await searchFor("only");
      await expect
        .element(page.getByRole("button", { name: /OnlySearchResult\.md/ }))
        .toBeInTheDocument();

      await pressSearchInputKey("Escape");

      await vi.waitFor(() => {
        expect((page.getByPlaceholder("Search files").element() as HTMLInputElement).value).toBe(
          "",
        );
      });
      await expect.element(page.getByText("App.tsx")).toBeInTheDocument();
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").not.toContain("OnlySearchResult.md");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("clears search and expands the directory when a directory result is clicked", async () => {
    searchEntries.mockResolvedValue({
      entries: [{ path: "src/components", kind: "directory" }],
      truncated: false,
    });
    const mounted = await renderPanel();
    try {
      await searchFor("components");
      await page.getByRole("button", { name: /components/ }).click();

      await vi.waitFor(() => {
        expect((page.getByPlaceholder("Search files").element() as HTMLInputElement).value).toBe(
          "",
        );
      });
      await expect.element(page.getByText("FileBrowserPanel.tsx")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });
});
