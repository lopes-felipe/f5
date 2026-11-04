import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { expect, it } from "vitest";

it("resolves bundled providers after the standalone CJS import.meta.url rewrite", () => {
  const directory = realpathSync(mkdtempSync(Path.join(tmpdir(), "f5-codex-cjs-")));
  const repo = Path.resolve(import.meta.dirname, "..");
  const config = Path.join(directory, "tsdown.config.mjs");
  try {
    writeFileSync(
      config,
      "export default { entry: " +
        JSON.stringify({
          codex: Path.join(repo, "apps/server/src/provider/codexExecutable.ts"),
          claude: Path.join(repo, "apps/server/src/provider/claudeSdkExecutable.ts"),
        }) +
        ", platform: 'node', format: ['cjs'], outDir: " +
        JSON.stringify(Path.join(directory, "dist")) +
        ", noExternal: () => true, checks: { legacyCjs: false } };",
    );
    execFileSync(
      process.execPath,
      [Path.join(repo, "apps/server/node_modules/tsdown/dist/run.mjs"), "--config", config],
      { cwd: repo, timeout: 20_000, stdio: "pipe" },
    );
    const output = Path.join(directory, "dist");
    const fixture = (relative: string, contents = "") => {
      const file = Path.join(output, "node_modules", relative);
      mkdirSync(Path.dirname(file), { recursive: true });
      writeFileSync(file, contents);
      return file;
    };
    fixture("@openai/codex/package.json", "{}");
    fixture("@openai/codex-darwin-arm64/package.json", "{}");
    const vendor = "@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/";
    fixture(
      vendor + "codex-package.json",
      JSON.stringify({
        layoutVersion: 1,
        target: "aarch64-apple-darwin",
        entrypoint: "bin/codex",
      }),
    );
    const codex = fixture(vendor + "bin/codex");
    fixture("@anthropic-ai/claude-agent-sdk/package.json", JSON.stringify({ main: "index.js" }));
    fixture("@anthropic-ai/claude-agent-sdk/index.js");
    const claude = fixture("@anthropic-ai/claude-agent-sdk-darwin-arm64/claude");
    const moduleRequire = createRequire(import.meta.url);
    const bundled = moduleRequire(Path.join(directory, "dist", "codex.cjs")) as {
      resolveBundledCodexExecutable(platform: string, arch: string, options: object): string;
    };
    expect(bundled.resolveBundledCodexExecutable("darwin", "arm64", { electron: false })).toBe(
      codex,
    );
    const bundledClaude = moduleRequire(Path.join(output, "claude.cjs")) as {
      resolveBundledClaudeExecutable(platform: string, arch: string): string;
    };
    expect(bundledClaude.resolveBundledClaudeExecutable("darwin", "arm64")).toBe(claude);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
