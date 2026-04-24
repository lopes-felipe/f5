import "../../index.css";

import type { OrchestrationCommandExecution } from "@t3tools/contracts";
import { TurnId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

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

  it("copies the displayed normalized command and does not toggle expansion", async () => {
    const onToggle = vi.fn();
    const toastSpy = vi.spyOn(toastManager, "add");
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <CommandTranscriptCard
        execution={makeExecution()}
        expanded={false}
        nowIso="2026-03-20T12:00:02.000Z"
        timestampFormat="locale"
        onToggle={onToggle}
        onExpandedBodyResize={() => {}}
      />,
      { container: host },
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

  it("shows an error toast when clipboard writes fail", async () => {
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
    const screen = await render(
      <CommandTranscriptCard
        execution={makeExecution({
          command: "Bash: {}",
          detail: "Bash: pwd",
          output: "/Users/felipelopes/dev/wolt/f3-code",
        })}
        expanded
        nowIso="2026-03-20T12:00:02.000Z"
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
      { container: host },
    );

    try {
      await page.getByRole("button", { name: "Copy command" }).click();

      await vi.waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith("pwd");
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            title: "Could not copy command",
            description: "Permission denied",
          }),
        );
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("copies the command instead of a distinct summary title", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <CommandTranscriptCard
        execution={makeExecution({
          command: "/bin/zsh -lc 'echo hello'",
          title: "Echo greeting",
        })}
        expanded={false}
        nowIso="2026-03-20T12:00:02.000Z"
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
      { container: host },
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
