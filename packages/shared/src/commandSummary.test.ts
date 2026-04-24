import { describe, expect, it } from "vitest";

import {
  classifyCompactCommand,
  deriveNarratedActivityDisplayHints,
  deriveSearchCommandSummary,
  detectFileReadCommand,
  displayCommandExecutionCommand,
  normalizeCommandExecutionDetail,
  resolveCommandExecutionSummaryText,
} from "./commandSummary";

describe("commandSummary", () => {
  it("strips common posix shell wrappers", () => {
    expect(displayCommandExecutionCommand("/bin/zsh -lc 'uname -a'")).toBe("uname -a");
    expect(displayCommandExecutionCommand("/bin/bash -lc bun\\ run\\ lint")).toBe(
      "bun\\ run\\ lint",
    );
  });

  it("derives search summaries for ripgrep pipelines truncated with head", () => {
    expect(
      deriveSearchCommandSummary(
        "rg -n 'chat\\.newLocal|chat\\.scrollToBottom|workflow\\.new|KeybindingCommand|shortcutCommand' apps packages | head -n 300",
      ),
    ).toBe("Searching apps, packages for chat.newLocal, chat.scrollToBottom, workflow.new, …");
  });

  it("derives search summaries for grep and git grep", () => {
    expect(deriveSearchCommandSummary("grep -R -n -e foo -e bar src")).toBe(
      "Searching src for foo, bar",
    );
    expect(deriveSearchCommandSummary('git grep -n "CommandTranscriptCard"')).toBe(
      "Searching workspace for CommandTranscriptCard",
    );
    expect(deriveSearchCommandSummary("find apps/web/src -type f -name '*.tsx'")).toBe(
      "Searching apps/web/src for *.tsx",
    );
    expect(deriveSearchCommandSummary("fd --glob '*.tsx' apps/web/src")).toBe(
      "Searching apps/web/src for *.tsx",
    );
  });

  it("keeps complex regex patterns as raw previews", () => {
    expect(deriveSearchCommandSummary("rg -n 'foo.*bar|baz' apps")).toBe(
      "Searching apps for foo.*bar|baz",
    );
  });

  it("rejects unsupported search pipelines", () => {
    expect(deriveSearchCommandSummary("rg foo src | sort")).toBeNull();
  });

  it("rejects chained or dynamically-expanded search commands", () => {
    expect(deriveSearchCommandSummary("rg foo src && echo done")).toBeNull();
    expect(deriveSearchCommandSummary("rg foo src || echo done")).toBeNull();
    expect(deriveSearchCommandSummary("rg foo src; echo done")).toBeNull();
    expect(deriveSearchCommandSummary("rg foo $(pwd)")).toBeNull();
  });

  it("keeps file-read detection unchanged for rg pipelines with head", () => {
    expect(detectFileReadCommand('rg -n "CommandTranscriptCard" apps/web/src | head')).toBeNull();
  });

  it("prefers search classification over ripgrep file-read heuristics", () => {
    expect(
      classifyCompactCommand(
        'rg -n "EntryIcon|data-lucide|lucide" apps/web/src/components/chat/MessagesTimeline.tsx',
      ),
    ).toEqual({
      kind: "search",
      summary:
        "Searching apps/web/src/components/chat/MessagesTimeline.tsx for EntryIcon, data-lucide, lucide",
    });
  });

  it("uses search summaries for generic command transcript titles", () => {
    expect(
      resolveCommandExecutionSummaryText({
        command:
          "rg -n 'chat\\.newLocal|chat\\.scrollToBottom|workflow\\.new|KeybindingCommand|shortcutCommand' apps packages | head -n 300",
        title: "Ran command",
        detail: null,
      }),
    ).toBe("Searching apps, packages for chat.newLocal, chat.scrollToBottom, workflow.new, …");
  });

  it("normalizes Claude shell tool detail summaries", () => {
    expect(normalizeCommandExecutionDetail('Bash: echo "Hello" && date')).toBe(
      'echo "Hello" && date',
    );
  });

  it("derives display hints from narrated reasoning updates", () => {
    expect(
      deriveNarratedActivityDisplayHints(
        "Reading lines 120-180 of apps/web/src/components/ui/alert.tsx",
      ),
    ).toEqual({
      readPaths: ["apps/web/src/components/ui/alert.tsx"],
      lineSummary: "lines 120-180",
    });

    expect(
      deriveNarratedActivityDisplayHints(
        'Running grep -r "serverConfigQuery|useServerConfig" apps/web/src',
      ),
    ).toEqual({
      searchSummary: "Searching apps/web/src for serverConfigQuery, useServerConfig",
    });

    expect(deriveNarratedActivityDisplayHints("Running fd --glob '*.tsx' apps/web/src")).toEqual({
      searchSummary: "Searching apps/web/src for *.tsx",
    });
  });
});
