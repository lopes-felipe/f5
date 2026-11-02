import type { OrchestrationCommandExecution } from "@t3tools/contracts";
import { TurnId } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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

function renderCard(markup: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{markup}</QueryClientProvider>,
  );
}

describe("CommandTranscriptCard", () => {
  it("renders completed status as a labelled success icon and accent", () => {
    const markup = renderCard(
      <CommandTranscriptCard
        execution={makeExecution({
          status: "completed",
        })}
        expanded={false}
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Completed"');
    expect(markup).toContain("border-l-success/70");
    expect(markup).toContain("text-success");
    expect(markup).not.toContain(">completed<");
  });

  it("renders running status as a spinning info icon", () => {
    const markup = renderCard(
      <CommandTranscriptCard
        execution={makeExecution({
          status: "running",
          exitCode: null,
          completedAt: null,
          updatedAt: "2026-03-20T12:00:00.500Z",
        })}
        expanded={false}
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Running"');
    expect(markup).toContain("border-l-info/70");
    expect(markup).toContain("animate-spin");
  });

  it("shows the command, not the title, for Claude background commands", () => {
    const markup = renderCard(
      <CommandTranscriptCard
        execution={makeExecution({
          command: "/bin/zsh -lc 'df -h /System/Volumes/Data'",
          title: "Command run — completed",
        })}
        expanded={false}
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(markup).not.toContain("Command run");
    expect(markup).toContain("/System/Volumes/Data");
    expect(markup).toContain(">background</span>");
    expect(markup).toContain("Ran in the background (completed)");
  });

  it("renders the provider description above the command", () => {
    const markup = renderCard(
      <CommandTranscriptCard
        execution={makeExecution({ description: "Check free disk space" })}
        expanded={false}
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(markup).toContain("Check free disk space");
    expect(markup).not.toContain(">background</span>");
  });

  it("only shows non-zero exit codes and keeps the start time in a tooltip", () => {
    const success = renderCard(
      <CommandTranscriptCard
        execution={makeExecution({ exitCode: 0 })}
        expanded={false}
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );
    const failure = renderCard(
      <CommandTranscriptCard
        execution={makeExecution({ status: "failed", exitCode: 2, output: "" })}
        expanded={false}
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(success).not.toContain("exit 0");
    expect(success).toContain('title="Started ');
    expect(success).toContain("<span>1.0s</span>");
    expect(failure).toContain("exit 2");
    expect(failure).toContain('aria-label="Failed"');
  });

  it("shows the last output lines of a collapsed failed command", () => {
    const markup = renderCard(
      <CommandTranscriptCard
        execution={makeExecution({
          status: "failed",
          exitCode: 1,
          output: ["line-1", "line-2", "", "line-3", "line-4", "error: boom", "  "].join("\n"),
        })}
        expanded={false}
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(markup).toContain("line-2\nline-3\nline-4\nerror: boom</pre>");
    expect(markup).not.toContain("line-1");
    // The tail sits outside the toggle button so its text stays selectable.
    const buttonMarkup = markup.slice(0, markup.indexOf("</button>"));
    expect(buttonMarkup).not.toContain("command-failed-output-tail");
  });

  it("keeps the end of an oversized single-line failure within the tail budget", () => {
    const markup = renderCard(
      <CommandTranscriptCard
        execution={makeExecution({
          status: "failed",
          exitCode: 1,
          output: `${"x".repeat(250_000)}FINAL-ERROR`,
        })}
        expanded={false}
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    const tail = /data-testid="command-failed-output-tail"[^>]*>([^<]*)<\/pre>/.exec(markup)?.[1];
    expect(tail?.endsWith("FINAL-ERROR")).toBe(true);
    expect(tail?.startsWith("…")).toBe(true);
    expect(tail?.length).toBeLessThanOrEqual(600);
  });

  it("does not show an output tail for collapsed successful commands", () => {
    const markup = renderCard(
      <CommandTranscriptCard
        execution={makeExecution({ output: "SUCCESS-OUTPUT" })}
        expanded={false}
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(markup).not.toContain("SUCCESS-OUTPUT");
  });

  it("shows the cwd only when it differs from the workspace root", () => {
    const renderWithCwd = (cwd: string) =>
      renderCard(
        <CommandTranscriptCard
          execution={makeExecution({ cwd })}
          expanded
          timestampFormat="locale"
          workspaceRoot="/Users/me/project/"
          onToggle={() => {}}
          onExpandedBodyResize={() => {}}
        />,
      );

    expect(renderWithCwd("/Users/me/project")).not.toContain("in project");
    expect(renderWithCwd("/users/ME/Project")).not.toContain(">in ");
    expect(renderWithCwd("/Users/me/project/apps/web")).toContain("in project/apps/web");
    expect(renderWithCwd("/tmp/scratch")).toContain("in /tmp/scratch");
  });

  it("does not repeat the same command in header, command, and detail sections", () => {
    const command = "/bin/zsh -lc 'echo hello'";
    const markup = renderCard(
      <CommandTranscriptCard
        execution={makeExecution({
          command,
          title: command,
          detail: command,
        })}
        expanded
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(markup.match(/Command<\/p>/g)).toBeNull();
    expect(markup.match(/Detail<\/p>/g)).toBeNull();
    expect(markup).toContain("echo");
    expect(markup).toContain("hello");
    expect(markup).not.toContain(command);
  });

  it("shows the full command section when the title is a distinct summary", () => {
    const command = "/bin/zsh -lc 'echo hello'";
    const markup = renderCard(
      <CommandTranscriptCard
        execution={makeExecution({
          command,
          title: "Echo greeting",
        })}
        expanded
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(markup).toContain("Echo greeting");
    expect(markup).toContain(">Command</p>");
    expect(markup).toContain("echo");
    expect(markup).toContain("hello");
    expect(markup).not.toContain(command);
  });

  it("prefers the actual command over generic provider titles", () => {
    const command = "/bin/zsh -lc date";
    const displayCommand = "date";
    const markup = renderCard(
      <CommandTranscriptCard
        execution={makeExecution({
          command,
          title: "Ran command",
        })}
        expanded
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(markup).not.toContain("Ran command");
    expect(markup).toContain(displayCommand);
    expect(markup).not.toContain(command);
    expect(markup.match(/Command<\/p>/g)).toBeNull();
  });

  it("shows derived search summaries for generic grep-style command titles", () => {
    const command =
      "rg -n 'chat\\.newLocal|chat\\.scrollToBottom|workflow\\.new|KeybindingCommand|shortcutCommand' apps packages | head -n 300";
    const markup = renderCard(
      <CommandTranscriptCard
        execution={makeExecution({
          command,
          title: "Ran command",
        })}
        expanded
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(markup).toContain(
      "Searching apps, packages for chat.newLocal, chat.scrollToBottom, workflow.new, …",
    );
    expect(markup).toContain(">Command</p>");
    expect(markup).toContain("rg");
    expect(markup).toContain("apps");
    expect(markup).toContain("packages");
  });

  it("treats 'Command run' as a generic provider title", () => {
    const command = "/bin/zsh -lc date";
    const markup = renderCard(
      <CommandTranscriptCard
        execution={makeExecution({
          command,
          title: "Command run",
        })}
        expanded
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(markup).not.toContain("Command run");
    expect(markup).toContain("date");
    expect(markup.match(/Command<\/p>/g)).toBeNull();
  });

  it("renders lightweight syntax highlighting spans for displayed commands", () => {
    const markup = renderCard(
      <CommandTranscriptCard
        execution={makeExecution({
          command: "/bin/zsh -lc 'FOO=bar bun --watch $HOME ./script.sh $(pwd) 42'",
        })}
        expanded
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    // Syntax colours come from the semantic tokens so themes recolour them.
    expect(markup).toContain('<span class="text-attention-foreground">FOO=bar</span>');
    expect(markup).toContain('<span class="text-info-foreground">bun</span>');
    expect(markup).toContain('<span class="text-warning-foreground">--watch</span>');
    expect(markup).toContain('<span class="text-destructive-foreground">$HOME</span>');
    expect(markup).toContain('<span class="text-success-foreground">./script.sh</span>');
    expect(markup).toContain('<span class="text-attention-foreground">$(pwd)</span>');
    expect(markup).toContain('<span class="text-warning-foreground">42</span>');
    expect(markup).not.toMatch(/text-(cyan|sky|amber|rose|teal|indigo|orange)-\d/);
    expect(markup).toContain("FOO=bar");
    expect(markup).toContain("bun");
    expect(markup).toContain("--watch");
    expect(markup).toContain("$HOME");
    expect(markup).toContain("./script.sh");
    expect(markup).toContain("$(pwd)");
    expect(markup).toContain("42");
  });

  it("collapses Claude shell tool summaries into the same compact command display", () => {
    const markup = renderCard(
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
    );

    expect(markup).toContain("pwd");
    expect(markup).not.toContain("Bash: {}");
    expect(markup).not.toContain(">Detail</p>");
    expect(markup).not.toContain("Command run");
  });

  it("renders a copy button when collapsed", () => {
    const markup = renderCard(
      <CommandTranscriptCard
        execution={makeExecution()}
        expanded={false}
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(markup).toContain('title="Copy command"');
    expect(markup).toContain("echo");
    expect(markup).toContain("hello");
  });

  it("renders a copy button when expanded", () => {
    const markup = renderCard(
      <CommandTranscriptCard
        execution={makeExecution()}
        expanded
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(markup).toContain('title="Copy command"');
    expect(markup).toContain(">Output</p>");
    expect(markup).toContain('aria-label="Copy output"');
  });

  it("hides the copy output button when there is no output", () => {
    const markup = renderCard(
      <CommandTranscriptCard
        execution={makeExecution({ output: "" })}
        expanded
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(markup).toContain("(no output)");
    expect(markup).not.toContain('aria-label="Copy output"');
  });

  it("shows a compact preview for very large outputs by default", () => {
    const markup = renderCard(
      <CommandTranscriptCard
        execution={makeExecution({
          output: [
            "preview-start",
            "A".repeat(9_000),
            "MIDDLE-SENTINEL",
            "B".repeat(9_000),
            "preview-end",
          ].join("\n"),
        })}
        expanded
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(markup).toContain("preview-start");
    expect(markup).toContain("preview-end");
    expect(markup).toContain("[... output preview shortened ...]");
    expect(markup).toContain("Show full output");
    expect(markup).not.toContain("MIDDLE-SENTINEL");
  });
});
