import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { atomicJson } from "./files";
import { runLauncher } from "./launcher";
import { managedChild } from "./handoff";

vi.mock("./handoff", async (original) => ({
  ...(await original<typeof import("./handoff")>()),
  managedChild: vi.fn(),
  recoverHandoff: async () => undefined,
  readUpdateOutcome: async () => undefined,
}));
vi.mock("./installation", async (original) => ({
  ...(await original<typeof import("./installation")>()),
  readInstalled: async () => ({ version: "1.0.0" }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it("stops a service child that never activates and releases its lease", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "f5-startup-stop-"));
  const stop = vi.fn(async () => {});
  vi.stubEnv("F5_LAUNCHER_SUPERVISOR", "");
  vi.mocked(managedChild).mockReturnValue({
    process: { pid: undefined, exitCode: null, signalCode: null },
    activated: new Promise(() => {}),
    stop,
  } as unknown as ReturnType<typeof managedChild>);
  const running = runLauncher(root, path.join(root, "state"), [], async (pid) => String(pid));
  try {
    await expect.poll(() => vi.mocked(managedChild).mock.calls.length).toBe(1);
    const lease = JSON.parse(await fs.readFile(path.join(root, "launcher.json"), "utf8"));
    await atomicJson(path.join(root, "service-stop.json"), { token: lease.token });
    await running;
    expect(stop).toHaveBeenCalledOnce();
    await expect(fs.access(path.join(root, "launcher.json"))).rejects.toThrow();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
