import { describe, expect, it } from "vitest";

import {
  detectFileReadCommand,
  displayCommandExecutionCommand,
  normalizeCommandExecutionDetail,
  resolveCommandExecutionDisplayCommand,
} from "@t3tools/shared/commandSummary";
import { tokenizeDisplayCommand } from "./commandExecutions";

describe("displayCommandExecutionCommand", () => {
  it("strips common posix shell wrappers", () => {
    expect(displayCommandExecutionCommand("/bin/zsh -lc 'uname -a'")).toBe("uname -a");
    expect(displayCommandExecutionCommand("/bin/bash -lc bun\\ run\\ lint")).toBe(
      "bun\\ run\\ lint",
    );
    expect(displayCommandExecutionCommand("fish -c 'echo hello'")).toBe("echo hello");
  });

  it("leaves non-wrapper commands unchanged", () => {
    expect(displayCommandExecutionCommand("bun run typecheck")).toBe("bun run typecheck");
    expect(displayCommandExecutionCommand("cmd.exe /d /s /c dir")).toBe("cmd.exe /d /s /c dir");
  });

  it("unescapes common single-quoted shell payloads", () => {
    expect(displayCommandExecutionCommand("/bin/zsh -lc 'printf '\"'\"'hello'\"'\"''")).toBe(
      "printf 'hello'",
    );
  });

  it("tokenizes commands into lightweight shell categories", () => {
    expect(
      tokenizeDisplayCommand(
        "FOO=bar bun run lint --fix $HOME ./script.sh $(pwd) 42 'src file.ts' | cat > /tmp/out.txt",
      ),
    ).toEqual([
      { text: "FOO=bar", kind: "env" },
      { text: " ", kind: "whitespace" },
      { text: "bun", kind: "command" },
      { text: " ", kind: "whitespace" },
      { text: "run", kind: "text" },
      { text: " ", kind: "whitespace" },
      { text: "lint", kind: "text" },
      { text: " ", kind: "whitespace" },
      { text: "--fix", kind: "flag" },
      { text: " ", kind: "whitespace" },
      { text: "$HOME", kind: "variable" },
      { text: " ", kind: "whitespace" },
      { text: "./script.sh", kind: "path" },
      { text: " ", kind: "whitespace" },
      { text: "$(pwd)", kind: "substitution" },
      { text: " ", kind: "whitespace" },
      { text: "42", kind: "number" },
      { text: " ", kind: "whitespace" },
      { text: "'src file.ts'", kind: "string" },
      { text: " ", kind: "whitespace" },
      { text: "|", kind: "operator" },
      { text: " ", kind: "whitespace" },
      { text: "cat", kind: "command" },
      { text: " ", kind: "whitespace" },
      { text: ">", kind: "operator" },
      { text: " ", kind: "whitespace" },
      { text: "/tmp/out.txt", kind: "path" },
    ]);
  });

  it("detects simple sed file reads after shell wrapper unwrapping", () => {
    expect(detectFileReadCommand("/bin/zsh -lc 'sed -n \"12p\" apps/web/src/main.tsx'")).toEqual({
      filePaths: ["apps/web/src/main.tsx"],
      lineSummary: "line 12",
    });
    expect(detectFileReadCommand("sed -n '12,18p' './src/file with spaces.ts'")).toEqual({
      filePaths: ["./src/file with spaces.ts"],
      lineSummary: "lines 12-18",
    });
    expect(detectFileReadCommand("sed -n '12p' apps/web/src/a.ts apps/web/src/b.ts")).toEqual({
      filePaths: ["apps/web/src/a.ts", "apps/web/src/b.ts"],
      lineSummary: "line 12",
    });
  });

  it("does not classify mutating or complex sed commands as file reads", () => {
    expect(detectFileReadCommand("sed -i 's/foo/bar/' apps/web/src/main.tsx")).toBeNull();
    expect(detectFileReadCommand("sed -n '12p' apps/web/src/main.tsx | cat")).toBeNull();
  });

  it("detects nl plus sed range pipelines as file reads", () => {
    expect(
      detectFileReadCommand(
        "/bin/zsh -lc \"nl -ba apps/web/src/routes/__root.tsx | sed -n '720,860p'\"",
      ),
    ).toEqual({
      filePaths: ["apps/web/src/routes/__root.tsx"],
      lineSummary: "lines 720-860",
    });
    expect(detectFileReadCommand("nl -ba './src/file with spaces.ts' | sed -n '12p'")).toEqual({
      filePaths: ["./src/file with spaces.ts"],
      lineSummary: "line 12",
    });
  });

  it("does not classify broader nl or sed pipelines as file reads", () => {
    expect(detectFileReadCommand("nl apps/web/src/main.tsx | sed -n '12p'")).toBeNull();
    expect(
      detectFileReadCommand("nl -ba apps/web/src/main.tsx apps/web/src/other.ts | sed -n '12p'"),
    ).toBeNull();
    expect(detectFileReadCommand("nl -ba apps/web/src/main.tsx | sed -n '12p' | cat")).toBeNull();
  });

  it("detects simple ripgrep searches with explicit path targets as file reads", () => {
    expect(
      detectFileReadCommand(
        'rg -n "function extractCommandExecutionCommand|extractCommandExecutionCommand\\(" apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts',
      ),
    ).toEqual({
      filePaths: ["apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts"],
    });
    expect(
      detectFileReadCommand(
        "rg -n \"CommandTranscriptCard\" apps/web/src/components/chat -g '*test*'",
      ),
    ).toEqual({
      filePaths: ["apps/web/src/components/chat"],
    });
  });

  it("does not classify ripgrep searches without explicit targets or with shell pipelines", () => {
    expect(detectFileReadCommand('rg -n "CommandTranscriptCard"')).toBeNull();
    expect(detectFileReadCommand('rg -n "CommandTranscriptCard" apps/web/src | head')).toBeNull();
    expect(detectFileReadCommand("rg -e foo -e bar src")).toEqual({
      filePaths: ["src"],
    });
    expect(detectFileReadCommand("rg --regexp=foo --regexp bar")).toBeNull();
  });

  it("prefers Claude command summaries over empty shell tool placeholders", () => {
    expect(
      resolveCommandExecutionDisplayCommand({
        command: "Bash: {}",
        detail: "Bash: pwd",
      }),
    ).toBe("pwd");
  });

  it("extracts command strings from serialized Claude shell tool payloads", () => {
    expect(
      resolveCommandExecutionDisplayCommand({
        command: 'Bash: {"command":"bun run lint"}',
        detail: null,
      }),
    ).toBe("bun run lint");
  });

  it("normalizes Claude shell tool detail summaries", () => {
    expect(normalizeCommandExecutionDetail('Bash: echo "Hello" && date')).toBe(
      'echo "Hello" && date',
    );
    expect(normalizeCommandExecutionDetail("plain detail")).toBe("plain detail");
  });
});
