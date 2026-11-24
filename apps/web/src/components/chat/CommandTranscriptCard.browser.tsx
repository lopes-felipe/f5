import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OrchestrationCommandExecution } from "@t3tools/contracts";
import { TurnId } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { FileNavigationProvider } from "../../fileNavigationContext";
import { setNowTickerClockForTests } from "../../lib/nowTicker";
import { toastManager } from "../ui/toast";
import { CommandTranscriptCard } from "./CommandTranscriptCard";

function makeExecution(
  overrides: Partial<OrchestrationCommandExecution> = {},
): OrchestrationCommandExecution {
  return {
    id: "command-execution-1" as OrchestrationCommandExecution["id"],
    threadId: "thread-1" as OrchestrationCommandExecution["threadId"],
    turnId: TurnId.makeUnsafe("turn-1"),
    providerItemId: null,
    command: "/bin/zsh -lc 'echo hello'",
    title: null,
    status: "completed",
    detail: null,
    exitCode: 0,
    output: "hello",
    outputTruncated: false,
    startedAt: "2026-03-20T12:00:00.000Z",
    completedAt: "2026-03-20T12:00:01.000Z",
    updatedAt: "2026-03-20T12:00:01.000Z",
    startedSequence: 1,
    lastUpdatedSequence: 2,
    ...overrides,
  };
}

function renderWithQueryClient(ui: ReactElement, host: HTMLElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>, {
    container: host,
  });
}

describe("CommandTranscriptCard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("stops a running command's clock, without jumping back, once the thread stops working", async () => {
    const startedAt = Date.parse("2026-03-20T12:00:00.000Z");
    let now = startedAt + 5_000;
    setNowTickerClockForTests(() => now);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.body.appendChild(document.createElement("div"));
    const ui = (threadWorking: boolean) => (
      <QueryClientProvider client={queryClient}>
        <CommandTranscriptCard
          execution={makeExecution({ status: "running", completedAt: null, exitCode: null })}
          expanded={false}
          timestampFormat="locale"
          threadWorking={threadWorking}
          onToggle={() => {}}
        />
      </QueryClientProvider>
    );
    const screen = await render(ui(true), { container: host });
    try {
      now = startedAt + 65_000;
      setNowTickerClockForTests(() => now);
      await vi.waitFor(() => expect(host.textContent).toContain("1m"));
      const lastShown = host.textContent;

      await screen.rerender(ui(false));
      expect(host.textContent).toBe(lastShown);
      now = startedAt + 600_000;
      setNowTickerClockForTests(() => now);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(host.textContent).toBe(lastShown);
    } finally {
      setNowTickerClockForTests(null);
      await screen.unmount();
    }
  });

  it("copies the displayed normalized command and does not toggle expansion", async () => {
    const onToggle = vi.fn();
    const toastSpy = vi.spyOn(toastManager, "add");
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <CommandTranscriptCard
        execution={makeExecution()}
        expanded={false}
        timestampFormat="locale"
        onToggle={onToggle}
        onExpandedBodyResize={() => {}}
      />,
      host,
    );

    try {
      await page.getByRole("button", { name: "Copy command" }).click();

      await vi.waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith("echo hello");
        expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith("/bin/zsh -lc 'echo hello'");
        expect(onToggle).not.toHaveBeenCalled();
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "success",
            title: "Command copied",
          }),
        );
      });

      await vi.waitFor(() => {
        expect(page.getByRole("button", { name: "Copied" })).toBeTruthy();
      });

      const icon = host.querySelector('[aria-label="Copied"] svg');
      expect(icon?.getAttribute("class")).toContain("text-success");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it.each([false, true])(
    "hides and copies fragmented PowerShell wrappers with expanded=%s",
    async (expanded) => {
      const onToggle = vi.fn();
      const host = document.createElement("div");
      document.body.append(host);
      const command = String.raw`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'bun typecheck *> "$env:TEMP'"\\f5-usage-pr-typecheck.log\""`;
      const body = String.raw`bun typecheck *> "$env:TEMP\f5-usage-pr-typecheck.log"`;
      const screen = await renderWithQueryClient(
        <CommandTranscriptCard
          execution={makeExecution({
            command,
            title: expanded ? "Read project instructions" : null,
          })}
          expanded={expanded}
          timestampFormat="locale"
          onToggle={onToggle}
          onExpandedBodyResize={() => {}}
        />,
        host,
      );
      try {
        expect(host.textContent).toContain(body);
        expect(host.textContent).not.toContain("powershell.exe");
        expect(host.textContent).not.toContain("-Command");
        await page.getByRole("button", { name: "Copy command" }).click();
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(body);
        expect(onToggle).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
        host.remove();
      }
    },
  );

  it("shows an error toast when clipboard writes fail", async () => {
    vi.spyOn(document, "execCommand").mockReturnValue(false);
    const clipboardError = new Error("Permission denied");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(clipboardError),
      },
    });
    const toastSpy = vi.spyOn(toastManager, "add");
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <CommandTranscriptCard
        execution={makeExecution({
          command: "Bash: {}",
          detail: "Bash: pwd",
          output: "/Users/felipelopes/dev/wolt/f3-code",
        })}
        expanded
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
      host,
    );

    try {
      await page.getByRole("button", { name: "Copy command" }).click();

      await vi.waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith("pwd");
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            title: "Could not copy command",
            description: "Clipboard copy failed.",
          }),
        );
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("renders running, background, failed and described cards", async () => {
    const host = document.createElement("div");
    host.style.width = "720px";
    host.style.padding = "16px";
    host.style.display = "grid";
    host.style.gap = "8px";
    document.body.append(host);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <CommandTranscriptCard
          execution={makeExecution({
            id: "command-running" as OrchestrationCommandExecution["id"],
            status: "running",
            exitCode: null,
            completedAt: null,
            command: "/bin/zsh -lc 'bun run test --filter web'",
          })}
          expanded={false}
          timestampFormat="locale"
          threadWorking={false}
          onToggle={() => {}}
        />
        <CommandTranscriptCard
          execution={makeExecution({
            id: "command-background" as OrchestrationCommandExecution["id"],
            title: "Command run — completed",
            description: "Remove pedregal worktrees",
            command:
              '/bin/zsh -lc \'cd ~/dev/wolt/pedregal; for w in inc3903-bounded-reader aobs-p11 aobs-p12 aobs-p14 aobs-p3 pr597075-feedback; do git worktree remove ".worktrees/$w" && echo "removed $w"; done; git worktree prune; git worktree list; df -h /System/Volumes/Data | tail -1\'',
          })}
          expanded={false}
          timestampFormat="locale"
          onToggle={() => {}}
        />
        <CommandTranscriptCard
          execution={makeExecution({
            id: "command-failed" as OrchestrationCommandExecution["id"],
            status: "failed",
            exitCode: 1,
            description: "Typecheck web",
            command: "/bin/zsh -lc 'bun run typecheck'",
            output: [
              "$ tsc --noEmit",
              "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
              "src/b.ts(4,1): error TS2304: Cannot find name 'foo'.",
              "",
              "Found 2 errors in 2 files.",
              'error: script "typecheck" exited with code 1',
            ].join("\n"),
          })}
          expanded={false}
          timestampFormat="locale"
          onToggle={() => {}}
        />
        <CommandTranscriptCard
          execution={makeExecution({
            id: "command-expanded" as OrchestrationCommandExecution["id"],
            description: "List web sources",
            cwd: "/Users/me/project/apps/web",
            output: "index.ts\nmain.tsx\n",
          })}
          expanded
          workspaceRoot="/Users/me/project"
          timestampFormat="locale"
          onToggle={() => {}}
        />
      </QueryClientProvider>,
      { container: host },
    );

    try {
      expect(host.textContent).not.toContain("Command run");
      expect(host.textContent).toContain("background");
      expect(host.textContent).toContain("Remove pedregal worktrees");
      expect(host.textContent).toContain("exit 1");
      expect(host.textContent).toContain("Found 2 errors in 2 files.");
      expect(host.textContent).not.toContain("$ tsc --noEmit");
      expect(host.textContent).toContain("in project/apps/web");
      const backgroundCommand = host.querySelectorAll("code")[1];
      expect(backgroundCommand?.className).toContain("line-clamp-2");
      expect(backgroundCommand!.getBoundingClientRect().height).toBeLessThan(60);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps the final failure line visible and clicks on the tail do not toggle", async () => {
    const onToggle = vi.fn();
    const host = document.createElement("div");
    host.style.width = "420px";
    document.body.append(host);
    const longDiagnostic = `src/very/long/path/${"segment/".repeat(30)}file.ts: error TS2322`;
    const screen = await renderWithQueryClient(
      <CommandTranscriptCard
        execution={makeExecution({
          status: "failed",
          exitCode: 1,
          output: [longDiagnostic, longDiagnostic, longDiagnostic, "FINAL-ERROR-LINE"].join("\n"),
        })}
        expanded={false}
        timestampFormat="locale"
        onToggle={onToggle}
      />,
      host,
    );

    try {
      const tail = host.querySelector<HTMLElement>('[data-testid="command-failed-output-tail"]');
      const clip = tail?.parentElement;
      expect(tail?.textContent).toContain("FINAL-ERROR-LINE");
      // Wrapped lines overflow the capped box at the top, not the bottom.
      expect(tail!.getBoundingClientRect().height).toBeGreaterThan(
        clip!.getBoundingClientRect().height,
      );
      const clipBottom = clip!.getBoundingClientRect().bottom;
      const paddingBottom = Number.parseFloat(getComputedStyle(clip!).paddingBottom);
      expect(Math.abs(tail!.getBoundingClientRect().bottom - (clipBottom - paddingBottom))).toBe(0);

      tail!.click();
      expect(onToggle).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("copies the full output from the expanded card", async () => {
    const toastSpy = vi.spyOn(toastManager, "add");
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <CommandTranscriptCard
        execution={makeExecution({ output: "line one\nline two\n" })}
        expanded
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
      host,
    );

    try {
      await page.getByRole("button", { name: "Copy output" }).click();

      await vi.waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith("line one\nline two\n");
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({ type: "success", title: "Output copied" }),
        );
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("toggles a large output between the preview and the full transcript", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <CommandTranscriptCard
        execution={makeExecution({
          output: ["A".repeat(9_000), "MIDDLE-SENTINEL", "B".repeat(9_000)].join("\n"),
        })}
        expanded
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
      host,
    );

    try {
      const showFull = page.getByRole("button", { name: "Show full output" });
      expect(showFull.element().getAttribute("aria-expanded")).toBe("false");
      expect(host.textContent).toContain("Shortened preview");
      await showFull.click();

      const showPreview = page.getByRole("button", { name: "Show preview" });
      await vi.waitFor(() => {
        expect(showPreview.element().getAttribute("aria-expanded")).toBe("true");
      });
      expect(host.textContent).toContain("MIDDLE-SENTINEL");
      expect(host.textContent).not.toContain("Shortened preview");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("numbers a sed read from its start line and keeps the numbers out of selections", async () => {
    const lines = Array.from({ length: 21 }, (_, index) => `const line${750 + index} = ${index};`);
    const host = document.createElement("div");
    document.body.append(host);
    const navigate = vi.fn(() => true);
    const screen = await renderWithQueryClient(
      <FileNavigationProvider value={navigate}>
        <CommandTranscriptCard
          execution={makeExecution({
            command: "/bin/zsh -lc 'sed -n 750,770p src/GitActionsControl.tsx'",
            output: `${lines.join("\n")}\n`,
          })}
          expanded
          timestampFormat="locale"
          workspaceRoot="/repo"
          onToggle={() => {}}
          onExpandedBodyResize={() => {}}
        />
      </FileNavigationProvider>,
      host,
    );

    try {
      const body = await vi.waitFor(() => {
        const element = host.querySelector<HTMLElement>("[data-output-kind='file']");
        expect(element).not.toBeNull();
        return element!.querySelector<HTMLElement>("[data-testid='command-output-body']")!;
      });
      const numbers = [...body.querySelectorAll("[data-line-number]")].map((row) =>
        Number(row.getAttribute("data-line-number")),
      );
      expect(numbers).toEqual(Array.from({ length: 21 }, (_, index) => 750 + index));
      expect(host.querySelector("[data-testid='command-output-chip']")?.textContent).toContain(
        "lines 750–770",
      );

      const selection = window.getSelection()!;
      selection.selectAllChildren(body);
      expect(selection.toString().trimEnd()).toBe(lines.join("\n"));
      selection.removeAllRanges();

      await page.getByRole("button", { name: "Open GitActionsControl.tsx at line 752" }).click();
      expect(navigate).toHaveBeenCalledWith("/repo/src/GitActionsControl.tsx:752", undefined);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("groups search results and opens files at the matched line", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const navigate = vi.fn(() => true);
    const screen = await renderWithQueryClient(
      <FileNavigationProvider value={navigate}>
        <CommandTranscriptCard
          execution={makeExecution({
            command: "rg -n useTheme src",
            output: "src/a.ts:3:const t = useTheme();\nsrc/b.tsx:12:useTheme()\n",
          })}
          expanded
          timestampFormat="locale"
          workspaceRoot="/repo"
          onToggle={() => {}}
          onExpandedBodyResize={() => {}}
        />
      </FileNavigationProvider>,
      host,
    );

    try {
      await vi.waitFor(() => {
        expect(host.querySelectorAll("[data-testid='command-output-search-group']")).toHaveLength(
          2,
        );
      });
      expect(host.querySelector("[data-testid='command-output-chip']")?.textContent).toBe(
        "2 matchesin 2 files",
      );
      expect(host.querySelectorAll("mark")).toHaveLength(2);

      await page.getByRole("button", { name: "src/b.tsx" }).click();
      expect(navigate).toHaveBeenLastCalledWith("/repo/src/b.tsx:12", undefined);
      await page.getByRole("button", { name: "Open a.ts at line 3" }).click();
      expect(navigate).toHaveBeenLastCalledWith("/repo/src/a.ts:3", undefined);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("splits a compound command's output into file sections, results and plain text", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const navigate = vi.fn(() => true);
    const output = [
      "     4\tconst a = 1;",
      "     5\tconst b = 2;",
      "origin/main:web/api.ts:12:export const nativeApi = 1;",
      "",
    ].join("\n");
    const screen = await renderWithQueryClient(
      <FileNavigationProvider value={navigate}>
        <CommandTranscriptCard
          execution={makeExecution({
            command:
              'nl -ba src/a.ts | sed -n 4,5p; git grep -n "nativeApi" origin/main -- web/api.ts',
            output,
          })}
          expanded
          timestampFormat="locale"
          workspaceRoot="/repo"
          onToggle={() => {}}
          onExpandedBodyResize={() => {}}
        />
      </FileNavigationProvider>,
      host,
    );

    try {
      const body = await vi.waitFor(() => {
        const element = host.querySelector<HTMLElement>("[data-output-kind='sections']");
        expect(element).not.toBeNull();
        return element!;
      });
      expect(body.querySelector("[data-testid='command-output-chip']")?.textContent).toBe(
        "a.ts1 match",
      );
      const file = body.querySelector<HTMLElement>("[data-testid='command-output-file-section']");
      expect(
        [...file!.querySelectorAll("[data-line-number]")].map((element) =>
          element.getAttribute("data-line-number"),
        ),
      ).toEqual(["4", "5"]);
      expect(body.querySelectorAll("mark")).toHaveLength(1);
      // The revision's results name the file but do not open the one on disk.
      expect(body.textContent).toContain("origin/main:web/api.ts");
      expect(body.querySelector("[data-testid='command-output-search-group'] button")).toBeNull();

      await page.getByRole("button", { name: "Open a.ts at line 5" }).click();
      expect(navigate).toHaveBeenLastCalledWith("/repo/src/a.ts:5", undefined);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("drops line numbers and marks counts partial for server-compacted output", async () => {
    const marker = "\n\n[... output compacted; 99999 bytes in total ...]\n\n";
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <>
        <CommandTranscriptCard
          execution={makeExecution({
            id: "command-execution-file" as OrchestrationCommandExecution["id"],
            command: "cat src/a.ts",
            output: `const a = 1;${marker}const z = 2;\n`,
            outputTruncated: true,
          })}
          expanded
          timestampFormat="locale"
          onToggle={() => {}}
          onExpandedBodyResize={() => {}}
        />
        <CommandTranscriptCard
          execution={makeExecution({
            id: "command-execution-search" as OrchestrationCommandExecution["id"],
            command: "grep -rnh foo src",
            output: `3:foo${marker}9:foo\n`,
            outputTruncated: true,
          })}
          expanded
          timestampFormat="locale"
          onToggle={() => {}}
          onExpandedBodyResize={() => {}}
        />
      </>,
      host,
    );

    try {
      const file = await vi.waitFor(() => {
        const element = host.querySelector<HTMLElement>("[data-output-kind='file']");
        expect(element).not.toBeNull();
        return element!;
      });
      expect(file.querySelectorAll("[data-line-number]")).toHaveLength(0);
      expect(file.textContent).toContain("output compacted");

      const search = await vi.waitFor(() => {
        const element = host.querySelector<HTMLElement>("[data-output-kind='search']");
        expect(element).not.toBeNull();
        return element!;
      });
      expect(search.querySelector("[data-testid='command-output-chip']")?.textContent).toContain(
        "partial",
      );
      // `grep -h` prints no path, so its line numbers are not buttons.
      expect(search.querySelectorAll("[data-line-number]")).toHaveLength(2);
      expect(search.querySelector("[data-testid='command-output-body'] button")).toBeNull();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("renders ANSI colors without escape characters and copies the stripped text", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <CommandTranscriptCard
        execution={makeExecution({
          command: "bun run test",
          output: "\x1b[1;31mFAIL\x1b[0m src/a.test.ts\n\x1b[32mpassed\x1b[39m 3\n",
        })}
        expanded
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
      host,
    );

    try {
      const body = await vi.waitFor(() => {
        const element = host.querySelector<HTMLElement>("[data-output-kind='ansi']");
        expect(element).not.toBeNull();
        return element!;
      });
      expect(body.textContent).not.toContain("\x1b");
      expect(body.textContent).toContain("FAIL src/a.test.ts");
      const fail = [...body.querySelectorAll("span")].find((span) => span.textContent === "FAIL");
      expect(fail?.className).toContain("text-destructive-foreground");
      expect(fail?.className).toContain("font-semibold");

      await page.getByRole("button", { name: "Copy output" }).click();
      await vi.waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
          "FAIL src/a.test.ts\npassed 3\n",
        );
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps large file output structured without syntax colors", async () => {
    const lines = Array.from({ length: 500 }, (_, index) => `const value${index} = "${index}";`);
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <>
        {/* A small control proves the grammar loaded, so a missing color in
            the big card is the size guard and not the Suspense fallback. */}
        <CommandTranscriptCard
          execution={makeExecution({
            id: "command-execution-small" as OrchestrationCommandExecution["id"],
            command: "cat src/small.ts",
            output: 'const small = "x";\n',
          })}
          expanded
          timestampFormat="locale"
          onToggle={() => {}}
          onExpandedBodyResize={() => {}}
        />
        <CommandTranscriptCard
          execution={makeExecution({
            id: "command-execution-big" as OrchestrationCommandExecution["id"],
            command: "cat src/big.ts",
            output: lines.join("\n"),
          })}
          expanded
          timestampFormat="locale"
          onToggle={() => {}}
          onExpandedBodyResize={() => {}}
        />
      </>,
      host,
    );

    try {
      const [small, big] = await vi.waitFor(
        () => {
          const cards = host.querySelectorAll<HTMLElement>("[data-output-kind='file']");
          expect(cards).toHaveLength(2);
          expect(cards[0]!.querySelector("span[style*='color']")).not.toBeNull();
          return [...cards];
        },
        { timeout: 10_000 },
      );
      expect(small).toBeDefined();
      expect(big!.querySelectorAll("[data-line-number]")).toHaveLength(500);
      expect(big!.querySelector("span[style*='color']")).toBeNull();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("renders a diff -u that exits 1, but not a failed one", async () => {
    const unified = "--- a.txt\n+++ b.txt\n@@ -1 +1 @@\n-a\n+b\n";
    const host = document.createElement("div");
    document.body.append(host);
    const card = (id: string, exitCode: number) => (
      <CommandTranscriptCard
        execution={makeExecution({
          id: id as OrchestrationCommandExecution["id"],
          command: "diff -u a.txt b.txt",
          output: unified,
          status: "failed",
          exitCode,
        })}
        expanded
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />
    );
    const screen = await renderWithQueryClient(
      <>
        {card("command-execution-differ", 1)}
        {card("command-execution-error", 2)}
      </>,
      host,
    );

    try {
      await vi.waitFor(() => {
        const kinds = [...host.querySelectorAll("[data-output-kind]")].map((element) =>
          element.getAttribute("data-output-kind"),
        );
        expect(kinds).toEqual(["diff", "plain"]);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("reaches line numbers from the keyboard as one tab stop", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const navigate = vi.fn(() => true);
    const screen = await renderWithQueryClient(
      <FileNavigationProvider value={navigate}>
        <CommandTranscriptCard
          execution={makeExecution({
            command: "sed -n 750,752p src/a.ts",
            output: "a\nb\nc\n",
          })}
          expanded
          timestampFormat="locale"
          workspaceRoot="/repo"
          onToggle={() => {}}
          onExpandedBodyResize={() => {}}
        />
      </FileNavigationProvider>,
      host,
    );

    try {
      const buttons = await vi.waitFor(() => {
        const found = host.querySelectorAll<HTMLButtonElement>("button[data-gutter-button]");
        expect(found).toHaveLength(3);
        return [...found];
      });
      expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1]);
      buttons[0]!.focus();
      await userEvent.keyboard("{ArrowDown}{ArrowDown}");
      expect(document.activeElement).toBe(buttons[2]);
      await userEvent.keyboard("{Enter}");
      expect(navigate).toHaveBeenCalledWith("/repo/src/a.ts:752", undefined);
      await userEvent.keyboard("{Home}");
      expect(document.activeElement).toBe(buttons[0]);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("highlights small file output once the grammar loads", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <CommandTranscriptCard
        execution={makeExecution({ command: "cat src/a.ts", output: 'const a = "x";\n' })}
        expanded
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
      host,
    );

    try {
      await vi.waitFor(
        () => {
          expect(
            host.querySelector("[data-output-kind='file'] span[style*='color']"),
          ).not.toBeNull();
        },
        { timeout: 10_000 },
      );
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("colors a command the same way collapsed and expanded", async () => {
    const command = 'node --version && echo "done" 2>/dev/null || true';
    const tokenColors = async (expanded: boolean, oversized = false) => {
      const host = document.createElement("div");
      document.body.append(host);
      const text = oversized ? `${command}\n${"# pad\n".repeat(500)}` : command;
      const screen = await renderWithQueryClient(
        <CommandTranscriptCard
          execution={makeExecution({ command: text, output: "" })}
          expanded={expanded}
          timestampFormat="locale"
          onToggle={() => {}}
          onExpandedBodyResize={() => {}}
        />,
        host,
      );
      try {
        const code = () => host.querySelector("button[aria-expanded] code");
        if (!oversized)
          await vi.waitFor(() => expect(code()?.querySelector("span[style]")).not.toBeNull(), {
            timeout: 10_000,
          });
        return [...(code()?.querySelectorAll("span[style], span[class]") ?? [])]
          .filter((span) => span.childElementCount === 0 && span.textContent?.trim())
          .slice(0, 20)
          .map((span) => `${span.textContent}|${getComputedStyle(span).color}`);
      } finally {
        await screen.unmount();
        host.remove();
      }
    };

    const collapsed = await tokenColors(false);
    expect(collapsed.length).toBeGreaterThan(0);
    expect(await tokenColors(true)).toEqual(collapsed);
    // Too big for inline highlighting: the lightweight palette, again in both states.
    const collapsedLarge = await tokenColors(false, true);
    expect(collapsedLarge.length).toBeGreaterThan(0);
    expect(await tokenColors(true, true)).toEqual(collapsedLarge);
  });

  it("copies the command instead of a distinct summary title", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <CommandTranscriptCard
        execution={makeExecution({
          command: "/bin/zsh -lc 'echo hello'",
          title: "Echo greeting",
        })}
        expanded={false}
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
      host,
    );

    try {
      await page.getByRole("button", { name: "Copy command" }).click();

      await vi.waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith("echo hello");
        expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith("Echo greeting");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
