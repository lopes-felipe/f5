import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OrchestrationCommandExecution } from "@t3tools/contracts";
import { TurnId } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

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
