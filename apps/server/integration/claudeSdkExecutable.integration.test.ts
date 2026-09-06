import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION_GATED_CLAUDE_MODELS } from "../src/provider/Layers/ClaudeProvider.ts";
import { compareCliVersions } from "../src/provider/cliVersion.ts";
import { resolveBundledClaudeExecutable } from "../src/provider/claudeSdkExecutable.ts";

describe("bundled Claude runtime compatibility", () => {
  it("pins a bundled runtime that satisfies every built-in model gate", () => {
    const require = createRequire(import.meta.url);
    // package.json is not exported; resolve the SDK entry through Node first.
    const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const manifest = require(path.join(path.dirname(sdkEntry), "package.json"));
    const serverManifest = require("../package.json");
    expect(manifest.version).toBe(serverManifest.dependencies["@anthropic-ai/claude-agent-sdk"]);
    const output = execFileSync(resolveBundledClaudeExecutable(), ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const version = output.match(/\d+\.\d+\.\d+/)?.[0];
    expect(version).toBeDefined();
    for (const gate of VERSION_GATED_CLAUDE_MODELS) {
      expect(compareCliVersions(version!, gate.minVersion), gate.slug).toBeGreaterThanOrEqual(0);
    }
  });
});
