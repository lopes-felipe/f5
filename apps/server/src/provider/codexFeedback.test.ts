import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexControlClient } from "../codex/CodexControlClient";
import { pruneCodexFeedback, saveCodexFeedback } from "./codexFeedback";
import { rpcMethodPolicy, rpcLongRunningTimeoutMs } from "@t3tools/shared/rpcScheduling";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});
async function directory() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "f5-feedback-test-"));
  directories.push(value);
  return value;
}
function client(version = "0.166.0") {
  const value = {
    cliVersion: version,
    saveFeedback: vi.fn(async (file: string) => {
      await fs.writeFile(file, "zip");
      return {};
    }),
    closeAndWait: vi.fn(async () => {}),
  };
  vi.spyOn(CodexControlClient, "create").mockResolvedValue(value as unknown as CodexControlClient);
  return value;
}
it("saves feedback independently of inventory with a dedicated long mutation policy", async () => {
  const root = await directory();
  const control = client();
  const result = await saveCodexFeedback({ cwd: root }, root, "../../instance");
  expect(path.dirname(result.path)).toBe(path.join(root, "diagnostics"));
  expect(await fs.readFile(result.path, "utf8")).toBe("zip");
  expect(control.saveFeedback).toHaveBeenCalledWith(result.path, 120000);
  expect(control.closeAndWait).toHaveBeenCalledOnce();
  expect(rpcMethodPolicy("server.saveProviderFeedback")).toMatchObject({
    kind: "mutation",
    lane: "long",
  });
  expect(rpcLongRunningTimeoutMs({ _tag: "server.saveProviderFeedback" })).toBe(130000);
});
it("rejects an older executable without attempting a save", async () => {
  const root = await directory();
  const control = client("0.162.0");
  await expect(saveCodexFeedback({ cwd: root }, root, "instance")).rejects.toThrow("0.166.0");
  expect(control.saveFeedback).not.toHaveBeenCalled();
  expect(control.closeAndWait).toHaveBeenCalledOnce();
});
it("closes the control client and removes its partial ZIP on timeout", async () => {
  const root = await directory();
  const control = client();
  let partial: string | undefined;
  control.saveFeedback.mockImplementation(async (file) => {
    partial = file;
    await fs.writeFile(file, "partial");
    return new Promise(() => {});
  });
  await expect(saveCodexFeedback({ cwd: root }, root, "instance", 50)).rejects.toThrow("timed out");
  expect(control.closeAndWait).toHaveBeenCalledOnce();
  if (partial) await expect(fs.stat(partial)).rejects.toMatchObject({ code: "ENOENT" });
});
it("retains ten recent bundles per instance, preserves the current file and ignores other files", async () => {
  const root = await directory();
  const current = path.join(root, "codex-feedback-instance-current.zip");
  const files = Array.from({ length: 14 }, (_, index) =>
    path.join(root, "codex-feedback-instance-" + index + ".zip"),
  );
  await Promise.all(
    [...files, current, path.join(root, "unrelated.zip")].map((file) => fs.writeFile(file, "zip")),
  );
  await fs.utimes(files[0]!, new Date(0), new Date(0));
  await pruneCodexFeedback(root, "codex-feedback-instance-", current);
  const remaining = await fs.readdir(root);
  expect(remaining).toHaveLength(11);
  expect(remaining).toContain("unrelated.zip");
  expect(remaining).toContain(path.basename(current));
  expect(remaining).not.toContain(path.basename(files[0]!));
});
