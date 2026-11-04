import { expect, it } from "vitest";
import { pinnedCliDependency } from "./build-cli-archive.ts";

it("preserves Codex platform package aliases in staged CLI overrides", () => {
  const packages = {
    "@openai/codex": ["@openai/codex@0.166.0"],
    "@openai/codex-darwin-arm64": ["@openai/codex@0.166.0-darwin-arm64"],
    "@openai/codex-linux-arm64": ["@openai/codex@0.166.0-linux-arm64"],
  };
  expect(pinnedCliDependency(packages, "@openai/codex")).toBe("0.166.0");
  expect(pinnedCliDependency(packages, "@openai/codex-darwin-arm64")).toBe(
    "npm:@openai/codex@0.166.0-darwin-arm64",
  );
  expect(pinnedCliDependency(packages, "@openai/codex-linux-arm64")).toBe(
    "npm:@openai/codex@0.166.0-linux-arm64",
  );
});

it("pins ordinary dependencies and rejects missing or malformed lock entries", () => {
  expect(pinnedCliDependency({ "node-pty": ["node-pty@1.1.0"] }, "node-pty")).toBe("1.1.0");
  expect(() => pinnedCliDependency({}, "missing")).toThrow("Missing pinned native dependency");
  expect(() => pinnedCliDependency({ malformed: [null] }, "malformed")).toThrow(
    "Missing pinned native dependency",
  );
});
