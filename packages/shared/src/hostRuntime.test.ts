import { afterEach, expect, it, vi } from "vitest";
import * as path from "node:path";
import { javascriptRuntimeExecutable } from "./hostRuntime";
afterEach(() => vi.unstubAllEnvs());
it("preserves the invocation runtime in source development and chooses bundled Node for SEA helpers", () => {
  vi.stubEnv("F5_STANDALONE_DIR", undefined);
  expect(javascriptRuntimeExecutable()).toBe(process.execPath);
  vi.stubEnv("F5_STANDALONE_DIR", path.resolve("test-runtime"));
  expect(javascriptRuntimeExecutable()).toBe(
    path.resolve("test-runtime", "runtime", process.platform === "win32" ? "node.exe" : "node"),
  );
});
