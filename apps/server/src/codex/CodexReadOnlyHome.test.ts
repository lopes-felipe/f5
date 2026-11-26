import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  codexProjectRulesConflictMessage,
  codexReadOnlyHomeDir,
  codexReadOnlySourceHome,
  findCodexProjectRulesConflict,
  materializeCodexReadOnlyHome,
} from "./CodexReadOnlyHome.ts";

const tempDir = async (prefix: string) => realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
const posixOnly = process.platform === "win32" ? it.skip : it;

async function sourceHome() {
  const root = await tempDir("f5-codex-ro-");
  const source = path.join(root, "source");
  await mkdir(path.join(source, "rules"), { recursive: true });
  await mkdir(path.join(source, "sessions", "2026"), { recursive: true });
  await writeFile(path.join(source, "auth.json"), '{"token":"a"}');
  await writeFile(path.join(source, "config.toml"), 'model = "x"\n');
  await writeFile(
    path.join(source, "rules", "default.rules"),
    'prefix_rule(pattern=["touch"], decision="allow")\n',
  );
  await mkdir(path.join(source, "log"));
  return { root, source, home: path.join(root, "readonly") };
}

describe("codexReadOnlySourceHome", () => {
  it("uses the configured home, else CODEX_HOME, else ~/.codex", () => {
    expect(codexReadOnlySourceHome("/configured", { CODEX_HOME: "/env" })).toBe(
      path.resolve("/configured"),
    );
    expect(codexReadOnlySourceHome(undefined, { CODEX_HOME: "/env" })).toBe(path.resolve("/env"));
    expect(codexReadOnlySourceHome("  ", { CODEX_HOME: " " })).toBe(
      path.join(os.homedir(), ".codex"),
    );
  });

  it("puts each instance's home under provider-homes/codex-readonly", () => {
    expect(codexReadOnlyHomeDir("/state/provider-homes", "codex_work")).toBe(
      path.join("/state/provider-homes", "codex-readonly", "codex_work"),
    );
  });
});

describe("materializeCodexReadOnlyHome", () => {
  posixOnly("links every entry of the source home except rules", async () => {
    const { source, home } = await sourceHome();
    await materializeCodexReadOnlyHome({ sourceHome: source, readOnlyHome: home });

    const entries = await readdir(home);
    expect(entries).not.toContain("rules");
    // Local entries stay out of the shared links, as in the shadow home.
    expect(entries).not.toContain("log");
    for (const name of ["auth.json", "config.toml", "sessions", "sqlite", "cache"]) {
      expect((await lstat(path.join(home, name))).isSymbolicLink()).toBe(true);
      expect(await readlink(path.join(home, name))).toBe(path.join(source, name));
    }
    // Writes through the sign-in link reach the instance's own file.
    await writeFile(path.join(home, "auth.json"), '{"token":"b"}');
    expect(await readFile(path.join(source, "auth.json"), "utf8")).toBe('{"token":"b"}');
  });

  posixOnly("removes a rules folder the read-only home gained", async () => {
    const { source, home } = await sourceHome();
    await materializeCodexReadOnlyHome({ sourceHome: source, readOnlyHome: home });
    await mkdir(path.join(home, "rules"));
    await writeFile(path.join(home, "rules", "default.rules"), "amendment");
    await materializeCodexReadOnlyHome({ sourceHome: source, readOnlyHome: home });
    expect(await readdir(home)).not.toContain("rules");
  });

  posixOnly("prunes stale links and repairs wrong or replaced entries", async () => {
    const { root, source, home } = await sourceHome();
    await materializeCodexReadOnlyHome({ sourceHome: source, readOnlyHome: home });
    await symlink(path.join(source, "gone"), path.join(home, "gone"));
    await writeFile(path.join(home, "kept-local-file"), "x");
    await rm(path.join(home, "config.toml"));
    await writeFile(path.join(home, "config.toml"), "rewritten locally");
    await rm(path.join(home, "sessions"));
    await symlink(root, path.join(home, "sessions"));

    await materializeCodexReadOnlyHome({ sourceHome: source, readOnlyHome: home });
    const entries = await readdir(home);
    expect(entries).not.toContain("gone");
    // Only links are pruned; a file F5 didn't create stays.
    expect(entries).toContain("kept-local-file");
    expect(await readlink(path.join(home, "config.toml"))).toBe(path.join(source, "config.toml"));
    expect(await readlink(path.join(home, "sessions"))).toBe(path.join(source, "sessions"));
  });

  posixOnly("never links a case variant of rules", async () => {
    const { source, home } = await sourceHome();
    await rename(path.join(source, "rules"), path.join(source, "Rules"));
    await materializeCodexReadOnlyHome({ sourceHome: source, readOnlyHome: home });
    expect((await readdir(home)).map((name) => name.toLowerCase())).not.toContain("rules");
    await mkdir(path.join(home, "RULES"));
    await materializeCodexReadOnlyHome({ sourceHome: source, readOnlyHome: home });
    expect((await readdir(home)).map((name) => name.toLowerCase())).not.toContain("rules");
  });

  posixOnly("starts without auth.json when Codex keeps sign-in in a file by default", async () => {
    const { source, home } = await sourceHome();
    await rm(path.join(source, "auth.json"));
    // A key under a table isn't the top-level setting.
    await writeFile(
      path.join(source, "config.toml"),
      '[profiles.work]\ncli_auth_credentials_store = "keyring"\n',
    );
    await materializeCodexReadOnlyHome({ sourceHome: source, readOnlyHome: home });
    expect(await readdir(home)).not.toContain("auth.json");
  });

  it.each(["keyring", "auto"])(
    "refuses a sign-in kept only in the keyring (cli_auth_credentials_store = %s)",
    async (store) => {
      const { source, home } = await sourceHome();
      await rm(path.join(source, "auth.json"));
      await writeFile(
        path.join(source, "config.toml"),
        `model = "x"\ncli_auth_credentials_store = "${store}"\n`,
      );
      await expect(
        materializeCodexReadOnlyHome({ sourceHome: source, readOnlyHome: home }),
      ).rejects.toThrow(
        `sign-in kept in your system keychain (cli_auth_credentials_store = "${store}"`,
      );
    },
  );

  posixOnly("links auth.json symbolically, never as a hard link, on Windows", async () => {
    const { source, home } = await sourceHome();
    await mkdir(home, { recursive: true });
    // An earlier build's hard link: Codex refuses to replace a hard-linked credential file.
    await link(path.join(source, "auth.json"), path.join(home, "auth.json"));
    await materializeCodexReadOnlyHome({
      sourceHome: source,
      readOnlyHome: home,
      platform: "win32",
    });
    expect((await lstat(path.join(home, "auth.json"))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(home, "auth.json"))).toBe(path.join(source, "auth.json"));
    // Other files stay hard links there.
    const config = await lstat(path.join(home, "config.toml"));
    expect(config.isSymbolicLink()).toBe(false);
    expect(config.ino).toBe((await lstat(path.join(source, "config.toml"))).ino);
  });

  posixOnly("ends with the same links when stages start together", async () => {
    const { source, home } = await sourceHome();
    await Promise.all(
      Array.from({ length: 4 }, () =>
        materializeCodexReadOnlyHome({ sourceHome: source, readOnlyHome: home }),
      ),
    );
    expect((await readdir(home)).sort()).toEqual(
      [
        "archived_sessions",
        "auth.json",
        "cache",
        "config.toml",
        "logs",
        "plugins",
        "sessions",
        "shell_snapshots",
        "skills",
        "sqlite",
        "thread-writer-locks",
        "worktrees",
      ].sort(),
    );
  });

  it("refuses a read-only home that is the source home", async () => {
    const { source } = await sourceHome();
    await expect(
      materializeCodexReadOnlyHome({ sourceHome: source, readOnlyHome: source }),
    ).rejects.toThrow("must be different");
  });
});

describe("findCodexProjectRulesConflict", () => {
  async function repository() {
    const root = await tempDir("f5-codex-rules-");
    const repo = path.join(root, "repo");
    const cwd = path.join(repo, "packages", "app");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await writeFile(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    await mkdir(cwd, { recursive: true });
    return { root, repo, cwd };
  }
  const writeRules = async (directory: string, contents: string, name = "default.rules") => {
    await mkdir(path.join(directory, ".codex", "rules"), { recursive: true });
    await writeFile(path.join(directory, ".codex", "rules", name), contents);
    return path.join(directory, ".codex", "rules", name);
  };

  it("finds rules in the working directory and in parents inside the repository", async () => {
    const { repo, cwd } = await repository();
    expect(await findCodexProjectRulesConflict(cwd)).toBeUndefined();
    const file = await writeRules(repo, 'prefix_rule(pattern=["ls"], decision="allow")\n');
    const conflict = await findCodexProjectRulesConflict(cwd);
    expect(conflict?.file).toBe(file);
    expect(codexProjectRulesConflictMessage(conflict!)).toContain(
      "can run commands without asking F5",
    );
    const inner = await writeRules(cwd, "x");
    expect((await findCodexProjectRulesConflict(cwd))?.file).toBe(inner);
  });

  it("ignores rules above the repository root, empty files and other files", async () => {
    const { root, repo, cwd } = await repository();
    await writeRules(root, "x");
    await writeRules(repo, "");
    await writeRules(repo, "notes", "README.md");
    expect(await findCodexProjectRulesConflict(cwd)).toBeUndefined();
  });

  it("checks only the working directory outside a repository", async () => {
    const root = await tempDir("f5-codex-rules-");
    const cwd = path.join(root, "work");
    await mkdir(cwd);
    await writeRules(root, "x");
    expect(await findCodexProjectRulesConflict(cwd)).toBeUndefined();
    await writeRules(cwd, "x");
    expect((await findCodexProjectRulesConflict(cwd))?.file).toContain(cwd);
  });

  it("finds the project root as Codex does: a .git file, or a .git folder with HEAD", async () => {
    const { root, repo, cwd } = await repository();
    const outer = await writeRules(root, "x");
    await writeFile(path.join(root, ".git"), "gitdir: elsewhere\n");
    // A `.git` folder without HEAD isn't a marker, so Codex keeps walking up to `root`.
    await rm(path.join(repo, ".git", "HEAD"));
    expect((await findCodexProjectRulesConflict(cwd))?.file).toBe(outer);
  });

  it("checks a home folder's .codex when a repository is rooted there", async () => {
    // Read-only stages run with F5's Codex home, so Codex reads `~/.codex` as a project layer of a
    // repository rooted at the home folder.
    const { repo, cwd } = await repository();
    const file = await writeRules(repo, "x");
    expect((await findCodexProjectRulesConflict(cwd))?.file).toBe(file);
  });

  posixOnly("blocks a rules entry that isn't a regular file", async () => {
    const { repo, cwd } = await repository();
    await mkdir(path.join(repo, ".codex", "rules", "dir.rules"), { recursive: true });
    expect((await findCodexProjectRulesConflict(cwd))?.reason).toBe("isn't a regular file");
  });
});
