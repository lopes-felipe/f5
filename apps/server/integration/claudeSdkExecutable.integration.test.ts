import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveAuxiliaryTextModel } from "../src/git/Layers/TextGenerationLive";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getBuiltInClaudeModelsForVersion,
  VERSION_GATED_CLAUDE_MODELS,
} from "../src/provider/Layers/ClaudeProvider.ts";
import { compareCliVersions } from "../src/provider/cliVersion.ts";
import { resolveBundledClaudeExecutable } from "../src/provider/claudeSdkExecutable.ts";

describe("bundled Claude runtime compatibility", () => {
  it("pins the bundled runtime and hides models above its version gates", () => {
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
    // Independent floor for the pinned SDK; newer optional models may be gated.
    expect(compareCliVersions(version!, "2.1.317")).toBeGreaterThanOrEqual(0);
    const models = getBuiltInClaudeModelsForVersion(version);
    expect(models[0]?.isUnlisted).not.toBe(true);
    const snapshot: ServerProvider = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      version: version!,
      status: "ready",
      auth: { status: "unknown" },
      checkedAt: new Date().toISOString(),
      models,
      modelCatalog: { status: "menu" },
      skills: [],
      slashCommands: [],
    };
    const selected = resolveAuxiliaryTextModel(
      createModelSelection(snapshot.instanceId, "claude-haiku-5-5"),
      snapshot,
    );
    expect(models.find((model) => model.slug === selected.model)?.isUnlisted).not.toBe(true);
    expect(["claude-haiku-5-5", "claude-haiku-4-5"]).toContain(selected.model);
    for (const gate of VERSION_GATED_CLAUDE_MODELS) {
      expect(models.find((model) => model.slug === gate.slug)?.isUnlisted === true, gate.slug).toBe(
        compareCliVersions(version!, gate.minVersion) < 0,
      );
    }
  });
});
