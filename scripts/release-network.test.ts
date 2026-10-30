import { beforeEach, expect, it, vi } from "vitest";
const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: execute,
}));
import { gh } from "./release/release-github.ts";
beforeEach(() => {
  execute.mockReset();
});
const transient = () => Object.assign(new Error("network"), { stderr: "HTTP 502: Server Error" });
it("retries a transient API read once, preserving its exact arguments", () => {
  execute
    .mockImplementationOnce(() => {
      throw transient();
    })
    .mockReturnValueOnce('{"ok":true}');
  expect(gh(["api", "repos/owner/repo/actions/runs"])).toBe('{"ok":true}');
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[0]).toEqual(execute.mock.calls[1]);
});
it("stops after one failed read retry and fails immediately on authentication errors", () => {
  execute.mockImplementation(() => {
    throw transient();
  });
  expect(() => gh(["api", "repos/owner/repo/actions/runs"])).toThrow("network");
  expect(execute).toHaveBeenCalledTimes(2);
  execute.mockReset().mockImplementation(() => {
    throw Object.assign(new Error("denied"), { stderr: "HTTP 403: Forbidden" });
  });
  expect(() => gh(["api", "repos/owner/repo/actions/runs"])).toThrow("denied");
  expect(execute).toHaveBeenCalledTimes(1);
});
it.each([
  ["release", "create", "v0.1.2"],
  ["release", "upload", "v0.1.2", "file"],
  ["workflow", "run", "release-upgrade.yml"],
  ["api", "--method", "POST", "repos/owner/repo/git/refs"],
  ["api", "repos/owner/repo/git/refs", "-f", "ref=refs/tags/v0.1.2"],
])("never blindly retries a mutation: %j", (...args) => {
  execute.mockImplementation(() => {
    throw transient();
  });
  expect(() => gh(args)).toThrow("network");
  expect(execute).toHaveBeenCalledTimes(1);
});
