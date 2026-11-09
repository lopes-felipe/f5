import {
  FileDiff,
  disposeHighlighter,
  getSharedHighlighter,
  parsePatchFiles,
  registerCustomTheme,
  VirtualizedFileDiff,
  Virtualizer,
} from "@pierre/diffs";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const patch = [
  "diff --git a/before.ts b/after.ts",
  "similarity index 50%",
  "rename from before.ts",
  "rename to after.ts",
  "--- a/before.ts",
  "+++ b/after.ts",
  "@@ -1,2 +1,2 @@",
  " const shared = 1;",
  "-const before = 2;",
  "+const after = 3;",
].join("\n");

let viewer: FileDiff<string> | undefined;
let pool: WorkerPoolManager | undefined;
let virtualizer: Virtualizer | undefined;
let container: HTMLDivElement;

beforeEach(async () => {
  await disposeHighlighter();
});

afterEach(() => {
  viewer?.cleanUp();
  viewer = undefined;
  virtualizer?.cleanUp();
  virtualizer = undefined;
  pool?.terminate();
  pool = undefined;
  container?.remove();
  vi.restoreAllMocks();
});

describe("collapsed diff highlighting", () => {
  it.each(["main thread", "worker", "virtualized worker"] as const)(
    "renders only headers until expansion with %s",
    async (mode) => {
      container = document.createElement("div");
      container.style.cssText = "height: 400px; width: 800px; overflow: auto";
      document.body.append(container);
      const highlighter = await getSharedHighlighter({
        themes: ["pierre-dark", "pierre-light"],
        langs: ["typescript"],
        preferredHighlighter: "shiki-wasm",
      });
      const tokenize = vi.spyOn(highlighter, "codeToHast");
      if (mode !== "main thread") {
        pool = new WorkerPoolManager(
          { workerFactory: () => new DiffsWorker(), poolSize: 1 },
          { theme: "pierre-dark", preferredHighlighter: "shiki-wasm" },
        );
        await pool.initialize();
      }
      const highlight = pool ? vi.spyOn(pool, "highlightDiffAST") : undefined;
      const plain = pool ? vi.spyOn(pool, "getPlainDiffAST") : undefined;
      const options = {
        theme: "pierre-dark",
        collapsed: true,
        disableErrorHandling: true,
        renderHeaderMetadata: () => {
          const span = document.createElement("span");
          span.textContent = "Review metadata";
          return span;
        },
      } as const;
      if (mode === "virtualized worker") {
        virtualizer = new Virtualizer();
        virtualizer.setup(container);
        viewer = new VirtualizedFileDiff<string>(options, virtualizer, undefined, pool);
      } else {
        viewer = new FileDiff<string>(options, pool);
      }
      const fileDiff = parsePatchFiles(patch, mode)[0]!.files[0]!;
      const code = () =>
        [...container.querySelectorAll("diffs-container")]
          .flatMap((node) => [...(node.shadowRoot?.querySelectorAll("[data-line]") ?? [])])
          .map((node) => node.textContent)
          .join("\n");
      const header = () => container.querySelector("diffs-container")?.shadowRoot?.textContent;
      viewer.render({ fileDiff, containerWrapper: container });
      if (viewer instanceof VirtualizedFileDiff) viewer.setVisibility(true);
      viewer.render({ fileDiff, forceRender: true });
      await vi.waitFor(() => expect(header()).toContain("after.ts"));
      expect(container.textContent).toContain("Review metadata");
      expect(code()).toBe("");
      expect(highlight?.mock.calls.length ?? 0).toBe(0);
      expect(plain?.mock.calls.length ?? 0).toBe(0);
      expect(tokenize).not.toHaveBeenCalled();
      // This Pierre version binds a virtualized instance to its initial file metadata.
      const updated =
        mode === "virtualized worker"
          ? fileDiff
          : { ...fileDiff, name: "updated.ts", cacheKey: mode + ":updated" };
      viewer.setOptions({ ...options, theme: "pierre-light" });
      viewer.render({ fileDiff: updated, forceRender: true });
      await vi.waitFor(() => expect(header()).toContain(updated.name));
      expect(code()).toBe("");
      expect(tokenize).not.toHaveBeenCalled();
      expect(highlight?.mock.calls.length ?? 0).toBe(0);
      expect(plain?.mock.calls.length ?? 0).toBe(0);
      viewer.setOptions({ ...options, theme: "pierre-light", collapsed: false });
      viewer.render({ fileDiff: updated, forceRender: true });
      await vi.waitFor(() => expect(code()).toContain("const after = 3;"));
      expect(code()).toContain("const before = 2;");
      if (mode === "main thread") expect(tokenize).toHaveBeenCalled();
      viewer.setOptions({ ...options, collapsed: true });
      viewer.render({ fileDiff: updated, forceRender: true });
      await vi.waitFor(() => expect(code()).toBe(""));
      viewer.setOptions({ ...options, collapsed: true, disableFileHeader: true });
      viewer.render({ fileDiff: updated, forceRender: true });
      await vi.waitFor(() =>
        expect(
          container
            .querySelector("diffs-container")
            ?.shadowRoot?.querySelector("[data-diffs-header]"),
        ).toBeNull(),
      );
    },
  );

  it("themes a cold collapsed header and updates it after a cold theme switch", async () => {
    container = document.createElement("div");
    document.body.append(container);
    const options = { collapsed: true, theme: "pierre-dark", disableErrorHandling: true } as const;
    viewer = new FileDiff(options);
    const fileDiff = parsePatchFiles(patch, "cold-theme")[0]!.files[0]!;
    const header = () =>
      container
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelector<HTMLElement>("[data-diffs-header]");
    viewer.render({ fileDiff, containerWrapper: container });
    // These assertions must precede the asynchronous theme load.
    expect(header()?.style.color).toBe("");
    expect(header()?.dataset.themeType).toBeUndefined();
    await vi.waitFor(() => {
      expect(header()?.dataset.themeType).toBe("dark");
      expect(header()?.style.color).not.toBe("");
      expect(header()?.style.backgroundColor).not.toBe("");
    });
    const darkColor = header()!.style.color;
    viewer.setOptions({ ...options, theme: "pierre-light" });
    viewer.render({ fileDiff, forceRender: true });
    expect(header()?.style.color).toBe("");
    await vi.waitFor(() => {
      expect(header()?.dataset.themeType).toBe("light");
      expect(header()?.style.color).not.toBe("");
      expect(header()?.style.color).not.toBe(darkColor);
    });
  });

  it("does not load a theme for a collapsed file with no header", async () => {
    await getSharedHighlighter({ themes: [], langs: [], preferredHighlighter: "shiki-wasm" });
    const loadTheme = vi.fn(async () => ({
      name: "collapsed-no-header",
      type: "dark" as const,
      colors: { "editor.foreground": "#ffffff", "editor.background": "#000000" },
      tokenColors: [],
    }));
    registerCustomTheme("collapsed-no-header", loadTheme);
    container = document.createElement("div");
    document.body.append(container);
    viewer = new FileDiff({
      collapsed: true,
      disableFileHeader: true,
      theme: "collapsed-no-header",
      disableErrorHandling: true,
    });
    const fileDiff = parsePatchFiles(patch, "no-header")[0]!.files[0]!;
    viewer.render({ fileDiff, containerWrapper: container });
    viewer.render({ fileDiff, forceRender: true });
    expect(loadTheme).not.toHaveBeenCalled();
    expect(
      container.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-diffs-header]"),
    ).toBeNull();
  });
});
