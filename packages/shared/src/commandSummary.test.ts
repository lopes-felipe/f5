import { describe, expect, it } from "vitest";

import {
  classifyCompactCommand,
  commandExecutionBackgroundStatus,
  deriveCommandExecutionLabel,
  deriveNarratedActivityDisplayHints,
  deriveSearchCommandSummary,
  detectFileReadCommand,
  displayCommandExecutionCommand,
  isGenericCommandTitle,
  normalizeCommandExecutionDetail,
  parseCommandExecutionTitle,
  resolveCommandExecutionDisplayCommand,
  resolveCommandExecutionSummaryText,
} from "./commandSummary";

describe("commandSummary", () => {
  it.each([
    String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content AGENTS.md'`,
    String.raw`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Get-Content AGENTS.md'`,
    String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command "Get-Content AGENTS.md"`,
    "powershell -c Get-Content AGENTS.md",
    "pwsh -Command 'Get-Content AGENTS.md'",
    "POWERSHELL.EXE -nOpRoFiLe -NoLogo -NonInteractive -ExecutionPolicy Bypass -COMMAND 'Get-Content AGENTS.md'",
    "'C:/Program Files/PowerShell/7/PWSH.EXE' -ExecutionPolicy \"RemoteSigned\" -NoProfile -c Get-Content AGENTS.md",
    "pwsh -ExecutionPolicy 'Bypass' -c Get-Content AGENTS.md",
  ])("strips PowerShell wrappers: %s", (command) => {
    expect(displayCommandExecutionCommand(command)).toBe("Get-Content AGENTS.md");
  });

  it.each([
    {
      command: String.raw`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'bun typecheck *> "$env:TEMP'"\\f5-usage-pr-typecheck.log\""`,
      body: String.raw`bun typecheck *> "$env:TEMP\f5-usage-pr-typecheck.log"`,
    },
    {
      command: String.raw`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '$env:F5_TEST_MAX_WORKERS='"'2'; bun run test:full *> \""'$env:TEMP'"\\f5-usage-pr-full.log\""`,
      body: String.raw`$env:F5_TEST_MAX_WORKERS='2'; bun run test:full *> "$env:TEMP\f5-usage-pr-full.log"`,
    },
    {
      command: `pwsh -c 'Write-Output '"'"'it is intact'"'"''`,
      body: "Write-Output 'it is intact'",
    },
  ])("decodes Codex quoted argv fragments: $body", ({ command, body }) => {
    expect(displayCommandExecutionCommand(command)).toBe(body);
    expect(resolveCommandExecutionDisplayCommand({ command })).toBe(body);
    const payload = `Shell: ${JSON.stringify({ command })}`;
    expect(resolveCommandExecutionDisplayCommand({ command: "Shell: {}", detail: payload })).toBe(
      body,
    );
  });

  it.each(["'", '"', ""])("preserves PowerShell script contents with %s wrapping", (quote) => {
    const body = [
      String.raw`$path = 'C:\new\test'; Get-Content "$path" | Select-Object -First 2`,
      "Write-Output `\"$env:HOME`\"; Write-Output 'it''s intact'",
    ].join("\n");
    expect(displayCommandExecutionCommand(`pwsh -Command ${quote}${body}${quote}`)).toBe(body);
  });

  it.each([
    "powershell -File script.ps1",
    "pwsh -EncodedCommand ZWNobw==",
    "pwsh -Unknown -Command 'echo hello'",
    "pwsh -ExecutionPolicy -Command 'echo hello'",
    "pwsh -Command",
    "pwsh -Command ''",
    "pwsh -Command -",
    "pwsh -Command 'unterminated",
    'pwsh -Command "unterminated',
    '"C:\\Program Files\\pwsh.exe -Command echo hello',
    "my-pwsh.exe -Command 'echo hello'",
    "cmd.exe /d /s /c dir",
    "bun run typecheck",
  ])("preserves unsupported or malformed invocations: %s", (command) => {
    expect(displayCommandExecutionCommand(command)).toBe(command);
  });

  it("normalizes resolved provider command and detail payloads", () => {
    const command = "pwsh -Command 'Get-Content AGENTS.md'";
    const payload = `Shell: ${JSON.stringify({ command })}`;
    expect(resolveCommandExecutionDisplayCommand({ command: payload })).toBe(
      "Get-Content AGENTS.md",
    );
    expect(resolveCommandExecutionDisplayCommand({ command: "Shell: {}", detail: payload })).toBe(
      "Get-Content AGENTS.md",
    );
    expect(resolveCommandExecutionDisplayCommand({ command: payload, detail: payload })).toBe(
      "Get-Content AGENTS.md",
    );
    expect(normalizeCommandExecutionDetail(payload)).toBe("Get-Content AGENTS.md");
    expect(normalizeCommandExecutionDetail("ordinary detail")).toBe("ordinary detail");
    expect(resolveCommandExecutionSummaryText({ command, title: "Ran command" })).toBe(
      "Get-Content AGENTS.md",
    );
  });

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

  it.each(["running", "completed", "failed", "stopped"] as const)(
    "treats Claude background titles ending in '%s' as generic",
    (status) => {
      const title = `Command run — ${status}`;
      expect(isGenericCommandTitle(title)).toBe(true);
      expect(parseCommandExecutionTitle(title)).toEqual({
        baseTitle: "Command run",
        backgroundStatus: status,
      });
      expect(commandExecutionBackgroundStatus({ title })).toBe(status);
    },
  );

  it("leaves titles without a known background suffix untouched", () => {
    expect(parseCommandExecutionTitle("Command run")).toEqual({
      baseTitle: "Command run",
      backgroundStatus: null,
    });
    expect(parseCommandExecutionTitle("Deploy — paused")).toEqual({
      baseTitle: "Deploy — paused",
      backgroundStatus: null,
    });
    expect(commandExecutionBackgroundStatus({ title: null })).toBeNull();
    expect(isGenericCommandTitle("Deploy — completed")).toBe(false);
  });

  it("shows the command instead of a generic background title", () => {
    expect(
      resolveCommandExecutionSummaryText({
        command: "/bin/zsh -lc 'df -h'",
        title: "Command run — completed",
      }),
    ).toBe("df -h");
  });

  it("drops the background suffix from specific titles", () => {
    expect(
      resolveCommandExecutionSummaryText({
        command: "/bin/zsh -lc 'bun run build'",
        title: "Build web — running",
      }),
    ).toBe("Build web");
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

describe("deriveCommandExecutionLabel", () => {
  it.each([
    ["cargo fmt --manifest-path apps/desktop/native/windows/Cargo.toml", "Format code"],
    ["bun fmt > /tmp/f5-uia-fmt.log 2>&1", "Format code"],
    [
      "cargo test --locked --manifest-path apps/desktop/native/windows/Cargo.toml > /tmp/rust.log 2>&1",
      "Run tests",
    ],
    [
      "cargo check --locked --target x86_64-pc-windows-msvc --manifest-path apps/desktop/native/windows/Cargo.toml",
      "Check build",
    ],
    ["bun lint > /tmp/f5-uia-lint.log 2>&1", "Lint"],
    ["bun typecheck > /tmp/f5-uia-typecheck.log 2>&1", "Typecheck"],
    ["bun run test:full > /tmp/f5-uia-full.log 2>&1", "Run tests"],
    ["bun run upstream-ports:check > /tmp/f5-uia-upstream.log 2>&1", "Run upstream-ports:check"],
    [
      "bun run --cwd apps/desktop test -- src/computer/a.test.ts src/computer/b.test.ts",
      "Run tests",
    ],
  ])("labels %s", (command, label) => {
    expect(deriveCommandExecutionLabel(command)).toBe(label);
  });

  it.each([
    ["cd /x && gh pr checks 385 2>/dev/null", "Check PR CI"],
    ["/bin/zsh -lc 'git status'", "Git status"],
    ["git -C /repo worktree list", "Manage worktrees"],
    ["git rev-parse HEAD", "Run git rev-parse"],
    ["FOO=1 env -i HOME=/tmp bun test", "Run tests"],
    ["timeout 30 npx vitest run src/a.test.ts", "Run tests"],
    ["bun fmt && bun lint", "Format code, Lint"],
    ["bun fmt && bun lint && bun typecheck", "Format code, Lint"],
    ["bun fmt; bun fmt", "Format code"],
    ["pnpm --filter web add zod", "Add zod"],
    ["npm ci", "Install dependencies"],
    ["bun scripts/build-release.ts --dry-run", "Run build-release.ts"],
    ["gh run view 41476031033 --log-failed", "Inspect CI run"],
    ["gh api repos/o/r/actions/jobs/1 -q '.steps'", "Call GitHub API"],
    ["curl -fsSL https://example.com/install.sh", "Fetch example.com"],
    ["make -C build test", "Make test"],
    ["command -v codex", "Locate codex"],
    ["python3 -m pytest tests", "Run tests"],
    ["node --import tsx scripts/audit.ts", "Run audit.ts"],
    ["sed -n 1,20p a.ts", "Read a.ts"],
    ["# run the suite\nbun run test", "Run tests"],
  ])("labels %s", (command, label) => {
    expect(deriveCommandExecutionLabel(command)).toBe(label);
  });

  it.each([
    "./scripts/foo --x",
    "",
    "   ",
    "echo hello",
    "cd /tmp",
    "date",
    "python3 -I -c 'print(1)'",
    "bun --watch $HOME ./script.sh",
    "gh auth status",
  ])("returns null for %j", (command) => {
    expect(deriveCommandExecutionLabel(command)).toBeNull();
  });

  it("matches the search summary for search commands", () => {
    const command = "rg -n 'foo' apps packages";
    expect(deriveCommandExecutionLabel(command)).toBe(deriveSearchCommandSummary(command));
  });
});
