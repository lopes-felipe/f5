import { expect, it } from "vitest";
import { pinnedCliDependency, selectCliRuntimeExternalDependencies } from "./cli-external-packages";
it("stages native runtime roots while bundling ordinary server dependencies", () => {
  expect(
    selectCliRuntimeExternalDependencies({
      "node-pty": "1",
      "@ff-labs/fff-node": "2",
      "@anthropic-ai/claude-agent-sdk": "3",
      undici: "8.11.2",
      effect: "4",
      ws: "5",
    }),
  ).toEqual({
    "node-pty": "1",
    "@ff-labs/fff-node": "2",
    "@anthropic-ai/claude-agent-sdk": "3",
    undici: "8.11.2",
  });
});

it("keeps Codex platform aliases intact when pinning staged runtime overrides", () => {
  const packages = {
    "@openai/codex": ["@openai/codex@0.166.0"],
    "@openai/codex-darwin-arm64": ["@openai/codex@0.166.0-darwin-arm64"],
    "@openai/codex-win32-x64": ["@openai/codex@0.166.0-win32-x64"],
    "@openai/codex-win32-arm64": ["@openai/codex@0.166.0-win32-arm64"],
    "node-pty": ["node-pty@1.1.0"],
  };
  expect(pinnedCliDependency(packages, "node-pty")).toBe("1.1.0");
  expect(pinnedCliDependency(packages, "@openai/codex")).toBe("0.166.0");
  for (const platform of ["darwin-arm64", "win32-x64", "win32-arm64"]) {
    expect(pinnedCliDependency(packages, "@openai/codex-" + platform)).toBe(
      "npm:@openai/codex@0.166.0-" + platform,
    );
  }
  expect(() => pinnedCliDependency(packages, "missing")).toThrow("Missing pinned");
});
