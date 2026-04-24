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
  it("renders completed badges with the success palette", () => {
    const markup = renderCard(
      <CommandTranscriptCard
        execution={makeExecution({
          status: "completed",
        })}
        expanded={false}
        nowIso="2026-03-20T12:00:02.000Z"
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(markup).toContain("border-success/32");
    expect(markup).toContain("bg-success/8");
    expect(markup).toContain("text-success-foreground");
  });

  it("renders running badges with the info palette", () => {
    const markup = renderCard(
      <CommandTranscriptCard
        execution={makeExecution({
          status: "running",
          exitCode: null,
          completedAt: null,
          updatedAt: "2026-03-20T12:00:00.500Z",
        })}
        expanded={false}
        nowIso="2026-03-20T12:00:02.000Z"
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(markup).toContain("border-info/32");
    expect(markup).toContain("bg-info/8");
    expect(markup).toContain("text-info-foreground");
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
        nowIso="2026-03-20T12:00:02.000Z"
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
        nowIso="2026-03-20T12:00:02.000Z"
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
        nowIso="2026-03-20T12:00:02.000Z"
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
        nowIso="2026-03-20T12:00:02.000Z"
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
        nowIso="2026-03-20T12:00:02.000Z"
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
        nowIso="2026-03-20T12:00:02.000Z"
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(markup).toContain("text-cyan-700");
    expect(markup).toContain("text-sky-700");
    expect(markup).toContain("text-amber-700");
    expect(markup).toContain("text-rose-700");
    expect(markup).toContain("text-teal-700");
    expect(markup).toContain("text-indigo-700");
    expect(markup).toContain("text-orange-700");
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
        nowIso="2026-03-20T12:00:02.000Z"
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
        nowIso="2026-03-20T12:00:02.000Z"
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
        nowIso="2026-03-20T12:00:02.000Z"
        timestampFormat="locale"
        onToggle={() => {}}
        onExpandedBodyResize={() => {}}
      />,
    );

    expect(markup).toContain('title="Copy command"');
    expect(markup).toContain(">Output</p>");
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
        nowIso="2026-03-20T12:00:02.000Z"
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
