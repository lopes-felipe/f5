import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  assertReadOnlyProjectConfig,
  claudeAllowRuleBypassesReadOnly,
  claudeGlobalConfigFile,
  claudeWorkspaceTrusted,
  findAntigravityProjectHooksConflict,
  findClaudeProjectConfigConflict,
  findOpenCodeProjectPluginConflict,
  findPiProjectExtensionConflict,
  projectDirectories,
} from "./readOnlyProjectConfig.ts";

const tempDir = async (prefix: string) => realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));

async function write(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** A git repository with `nested/` as the stage's folder, and a home outside it. */
async function repository() {
  const root = await tempDir("f5-ro-project-");
  const repo = path.join(root, "repo");
  const cwd = path.join(repo, "nested");
  await mkdir(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  return { root, repo, cwd, homeDir: path.join(root, "home") };
}

const gitAdd = (repo: string, file: string) =>
  execFileSync("git", ["-C", repo, "add", "--", path.relative(repo, file)]);

describe("projectDirectories", () => {
  it("walks from cwd to the repository root and skips the home folder", async () => {
    const { repo, cwd } = await repository();
    const result = await projectDirectories(cwd, { homeDir: repo });
    expect(result.repositoryRoot).toBe(repo);
    expect(result.project).toEqual([cwd]);
    expect(result.ancestors.slice(0, 2)).toEqual([cwd, repo]);
  });

  it("uses cwd alone outside a repository", async () => {
    const root = await tempDir("f5-ro-norepo-");
    const result = await projectDirectories(root);
    expect(result.project).toEqual([root]);
    expect(result.repositoryRoot).toBeUndefined();
  });
});

describe("assertReadOnlyProjectConfig", () => {
  it("names the file in the refusal", async () => {
    const exit = await Effect.runPromiseExit(
      assertReadOnlyProjectConfig({
        provider: "pi",
        providerName: "Pi",
        operation: "sendTurn",
        find: async () => ({ file: "/repo/.pi/extensions", reason: "holds Pi extensions" }),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain(
      "Pi can't run read-only workflow stages here: /repo/.pi/extensions holds Pi extensions.",
    );
  });

  it("refuses when the check itself fails", async () => {
    const exit = await Effect.runPromiseExit(
      assertReadOnlyProjectConfig({
        provider: "opencode",
        providerName: "OpenCode",
        operation: "startSession",
        find: async () => {
          throw new Error("EACCES");
        },
      }),
    );
    expect(JSON.stringify(exit)).toContain("F5 couldn't check the workspace's OpenCode project");
  });

  it("passes a clean workspace", async () => {
    const exit = await Effect.runPromiseExit(
      assertReadOnlyProjectConfig({
        provider: "pi",
        providerName: "Pi",
        operation: "startSession",
        find: async () => undefined,
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("claudeAllowRuleBypassesReadOnly", () => {
  it.each([
    ["Bash", true],
    ["Bash(*)", true],
    ["Bash(touch:*)", true],
    ["Bash(npm run *)", true],
    ["Bash(terraform apply:*)", true],
    ["Edit", true],
    ["Write(src/**)", true],
    ["MultiEdit", true],
    ["NotebookEdit", true],
    ["mcp__github__create_issue", true],
    // A prefix rule matches any arguments, and these programs' arguments can write or run code.
    ["Bash(git log:*)", true],
    ["Bash(git diff:*)", true],
    ["Bash(find:*)", true],
    ["Bash(sed:*)", true],
    ["Bash(ls -la:*)", true],
    ["Bash(cat:*)", false],
    ["Bash(ls *)", false],
    ["Bash(git status)", false],
    ["Bash(git log --oneline)", false],
    ["Read", false],
    ["WebFetch(domain:example.com)", false],
  ])("%s → %s", (rule, expected) => {
    expect(claudeAllowRuleBypassesReadOnly(rule)).toBe(expected);
  });
});

describe("findClaudeProjectConfigConflict", () => {
  async function trustedRepository(trusted = true) {
    const layout = await repository();
    const configFile = path.join(layout.root, ".claude.json");
    await write(
      configFile,
      JSON.stringify({
        projects: { [layout.repo]: { hasTrustDialogAccepted: trusted } },
      }),
    );
    return { ...layout, configFile };
  }

  it("refuses a committed allow rule in a trusted folder", async () => {
    const { repo, cwd, homeDir, configFile } = await trustedRepository();
    const settings = path.join(repo, ".claude", "settings.json");
    await write(
      settings,
      JSON.stringify({ permissions: { allow: ["Bash(cat:*)", "Bash(touch:*)"] } }),
    );
    gitAdd(repo, settings);
    expect(await findClaudeProjectConfigConflict(cwd, { homeDir, configFile })).toEqual({
      file: settings,
      reason:
        "allows `Bash(touch:*)`, which Claude would run without asking F5 in this trusted folder",
    });
  });

  it("ignores allow rules in a folder Claude Code doesn't trust", async () => {
    const { repo, cwd, homeDir, configFile } = await trustedRepository(false);
    const settings = path.join(repo, ".claude", "settings.json");
    await write(settings, JSON.stringify({ permissions: { allow: ["Bash"] } }));
    gitAdd(repo, settings);
    expect(await findClaudeProjectConfigConflict(cwd, { homeDir, configFile })).toBeUndefined();
  });

  it("ignores untracked local settings, deny rules and read-only allow rules", async () => {
    const { repo, cwd, homeDir, configFile } = await trustedRepository();
    await write(
      path.join(repo, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Bash"] } }),
    );
    const settings = path.join(cwd, ".claude", "settings.json");
    await write(
      settings,
      JSON.stringify({ permissions: { allow: ["Bash(git status)"], deny: ["Bash"] } }),
    );
    gitAdd(repo, settings);
    expect(await findClaudeProjectConfigConflict(cwd, { homeDir, configFile })).toBeUndefined();
  });

  it("refuses a committed settings file that isn't strict JSON", async () => {
    const { repo, cwd, homeDir, configFile } = await trustedRepository();
    const settings = path.join(repo, ".claude", "settings.json");
    await write(settings, "{ // comment\n}");
    gitAdd(repo, settings);
    const conflict = await findClaudeProjectConfigConflict(cwd, { homeDir, configFile });
    expect(conflict?.file).toBe(settings);
    expect(conflict?.reason).toContain("isn't strict JSON");
  });

  it("reads trust from CLAUDE_CONFIG_DIR, and from a trusted parent", async () => {
    const { root, cwd } = await repository();
    expect(claudeGlobalConfigFile({ CLAUDE_CONFIG_DIR: "/profile" }, "/home", "/stage")).toBe(
      path.join(path.resolve("/profile"), ".claude.json"),
    );
    // A relative CLAUDE_CONFIG_DIR resolves against the stage's folder, as the child resolves it.
    expect(claudeGlobalConfigFile({ CLAUDE_CONFIG_DIR: "profile" }, "/home", "/stage")).toBe(
      path.join(path.resolve("/stage", "profile"), ".claude.json"),
    );
    expect(claudeGlobalConfigFile({}, "/home", "/stage")).toBe(path.join("/home", ".claude.json"));
    const configFile = path.join(root, "config.json");
    await write(
      configFile,
      JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } } }),
    );
    expect(await claudeWorkspaceTrusted(cwd, { configFile })).toBe(true);
    expect(await claudeWorkspaceTrusted(cwd, { configFile: path.join(root, "missing") })).toBe(
      false,
    );
  });

  it("looks trust up by the folder's real path and fails on an unreadable config", async () => {
    const { root, repo } = await repository();
    const alias = path.join(root, "alias");
    await symlink(repo, alias);
    const configFile = path.join(root, "config.json");
    await write(
      configFile,
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    );
    expect(await claudeWorkspaceTrusted(alias, { configFile })).toBe(true);
    await write(configFile, "{ partly written");
    await expect(claudeWorkspaceTrusted(repo, { configFile })).rejects.toThrow("isn't valid JSON");
  });

  it("refuses command settings, unsafe env and permissive modes even in an untrusted folder", async () => {
    const { repo, cwd, homeDir, configFile } = await trustedRepository(false);
    const settings = path.join(repo, ".claude", "settings.json");
    await write(settings, "{}");
    gitAdd(repo, settings);
    const reasonFor = async (config: unknown) => {
      await write(settings, JSON.stringify(config));
      return (await findClaudeProjectConfigConflict(cwd, { homeDir, configFile }))?.reason;
    };
    expect(await reasonFor({ apiKeyHelper: "./bin/key" })).toContain("`apiKeyHelper`");
    expect(await reasonFor({ awsAuthRefresh: "aws sso login" })).toContain("`awsAuthRefresh`");
    expect(await reasonFor({ env: { PATH: "./bin:/usr/bin" } })).toContain("`PATH`");
    expect(await reasonFor({ env: { GIT_EXTERNAL_DIFF: "./x" } })).toContain("`GIT_EXTERNAL_DIFF`");
    expect(await reasonFor({ permissions: { defaultMode: "bypassPermissions" } })).toContain(
      "permissions.defaultMode",
    );
    expect(
      await reasonFor({
        env: { MAX_THINKING_TOKENS: "1000" },
        permissions: { defaultMode: "plan" },
      }),
    ).toBeUndefined();
  });

  it("checks settings outside a repository as part of the code under review", async () => {
    const root = await tempDir("f5-ro-claude-norepo-");
    const settings = path.join(root, ".claude", "settings.local.json");
    await write(settings, JSON.stringify({ apiKeyHelper: "./key" }));
    expect(
      (
        await findClaudeProjectConfigConflict(root, {
          homeDir: path.join(root, "home"),
          configFile: path.join(root, "missing.json"),
        })
      )?.file,
    ).toBe(settings);
  });

  it("fails when git can't tell whether a settings file is committed", async () => {
    const root = await tempDir("f5-ro-claude-badgit-");
    // A `.git` file pointing nowhere marks the root but makes every git command fail.
    await write(path.join(root, ".git"), "gitdir: /nonexistent/f5-gitdir\n");
    await write(path.join(root, ".claude", "settings.json"), "{}");
    await expect(
      findClaudeProjectConfigConflict(root, {
        homeDir: path.join(root, "home"),
        configFile: path.join(root, "missing.json"),
      }),
    ).rejects.toThrow("couldn't tell whether");
  });
});

describe("findOpenCodeProjectPluginConflict", () => {
  it("refuses a project plugin file", async () => {
    const { repo, cwd, homeDir } = await repository();
    const plugin = path.join(repo, ".opencode", "plugins", "audit.ts");
    await write(plugin, "export default {}");
    expect(await findOpenCodeProjectPluginConflict(cwd, { homeDir })).toEqual({
      file: plugin,
      reason: "is an OpenCode plugin, which runs code when OpenCode starts",
    });
  });

  it("refuses a plugin entry in opencode.json or .opencode/opencode.jsonc", async () => {
    const { repo, cwd, homeDir } = await repository();
    const config = path.join(repo, ".opencode", "opencode.jsonc");
    await write(config, JSON.stringify({ plugin: ["opencode-wakatime"] }));
    expect((await findOpenCodeProjectPluginConflict(cwd, { homeDir }))?.file).toBe(config);
  });

  it("refuses local MCP servers and LSP or formatter commands, and passes remote or disabled ones", async () => {
    const { repo, cwd, homeDir } = await repository();
    const config = path.join(repo, "opencode.json");
    const reasonFor = async (value: unknown) => {
      await write(config, JSON.stringify(value));
      return (await findOpenCodeProjectPluginConflict(cwd, { homeDir }))?.reason;
    };
    expect(
      await reasonFor({ mcp: { audit: { type: "local", command: ["sh", "-c", "touch marker"] } } }),
    ).toContain("local MCP server `audit`");
    expect(await reasonFor({ lsp: { custom: { command: ["./bin/lsp"] } } })).toContain(
      "LSP server `custom`",
    );
    expect(await reasonFor({ formatter: { fmt: { command: ["./fmt"] } } })).toContain(
      "formatter `fmt`",
    );
    expect(
      await reasonFor({
        mcp: {
          remote: { type: "remote", url: "https://example.com/mcp" },
          off: { type: "local", command: ["x"], enabled: false },
        },
        lsp: { custom: { command: ["./bin/lsp"], disabled: true } },
        formatter: false,
      }),
    ).toBeUndefined();
  });

  it("passes config without plugins and ignores folders above the repository", async () => {
    const { root, repo, cwd, homeDir } = await repository();
    await write(path.join(repo, "opencode.json"), JSON.stringify({ model: "x/y", plugin: [] }));
    await write(path.join(root, ".opencode", "plugin", "outside.js"), "");
    expect(await findOpenCodeProjectPluginConflict(cwd, { homeDir })).toBeUndefined();
  });
});

describe("findPiProjectExtensionConflict", () => {
  it("refuses project extensions", async () => {
    const { repo, cwd, homeDir } = await repository();
    await write(path.join(repo, ".pi", "extensions", "tool.ts"), "");
    expect(await findPiProjectExtensionConflict(cwd, { homeDir })).toEqual({
      file: path.join(repo, ".pi", "extensions", "tool.ts"),
      reason: "is a Pi extension, which runs code when Pi starts",
    });
  });

  it("refuses an extension folder but passes entries Pi doesn't load", async () => {
    const { repo, cwd, homeDir } = await repository();
    const extensions = path.join(repo, ".pi", "extensions");
    await write(path.join(extensions, ".gitkeep"), "");
    await write(path.join(extensions, "README.md"), "# Extensions");
    await write(path.join(extensions, "notes", "todo.txt"), "");
    expect(await findPiProjectExtensionConflict(cwd, { homeDir })).toBeUndefined();
    await write(path.join(extensions, "tool", "index.ts"), "");
    expect((await findPiProjectExtensionConflict(cwd, { homeDir }))?.file).toBe(
      path.join(extensions, "tool"),
    );
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails when the extensions folder can't be read",
    async () => {
      const { repo, cwd, homeDir } = await repository();
      const extensions = path.join(repo, ".pi", "extensions");
      await mkdir(extensions, { recursive: true });
      await chmod(extensions, 0o000);
      try {
        await expect(findPiProjectExtensionConflict(cwd, { homeDir })).rejects.toThrow("EACCES");
      } finally {
        await chmod(extensions, 0o755);
      }
    },
  );

  it("refuses packages in .pi/settings.json and passes an empty extensions folder", async () => {
    const { repo, cwd, homeDir } = await repository();
    await mkdir(path.join(repo, ".pi", "extensions"), { recursive: true });
    expect(await findPiProjectExtensionConflict(cwd, { homeDir })).toBeUndefined();
    const settings = path.join(cwd, ".pi", "settings.json");
    await write(settings, JSON.stringify({ packages: ["npm:pi-tools"] }));
    expect((await findPiProjectExtensionConflict(cwd, { homeDir }))?.file).toBe(settings);
  });
});

describe("findAntigravityProjectHooksConflict", () => {
  it("refuses workspace hooks and passes an empty hooks file", async () => {
    const { repo, cwd, homeDir } = await repository();
    const hooks = path.join(repo, ".agents", "hooks.json");
    await write(hooks, JSON.stringify({ hooks: { PreToolUse: [] } }));
    expect(await findAntigravityProjectHooksConflict(cwd, { homeDir })).toBeUndefined();
    await write(
      hooks,
      JSON.stringify({ hooks: { PreToolUse: [{ command: "curl https://example.com" }] } }),
    );
    expect(await findAntigravityProjectHooksConflict(cwd, { homeDir })).toEqual({
      file: hooks,
      reason: "defines hooks, which run shell commands",
    });
  });

  it("skips the home folder's own .agents", async () => {
    const { repo, cwd } = await repository();
    await write(path.join(repo, ".agents", "hooks.json"), JSON.stringify({ hooks: { a: [1] } }));
    expect(await findAntigravityProjectHooksConflict(cwd, { homeDir: repo })).toBeUndefined();
  });
});
