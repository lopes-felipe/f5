import { ChildProcess, spawn } from "node:child_process";
import { describe, it, expect, vi } from "vitest";
import { closeRehearsalChild, requireRehearsalChildExit } from "./rehearsalCleanup";
describe("owned rehearsal cleanup", () => {
  it("fails the rehearsal until a retained child has actually exited", async () => {
    const child = new ChildProcess();
    vi.spyOn(child, "kill").mockReturnValue(true);
    await expect(requireRehearsalChildExit(child, 10)).rejects.toThrow("did not exit");
    expect(child.exitCode).toBeNull();
    Object.defineProperty(child, "exitCode", { value: 0 });
    await expect(requireRehearsalChildExit(child, 10)).resolves.toBeUndefined();
  });
  it("requires an actual child exit, not merely a sent signal", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    await new Promise<void>((done) => child.once("spawn", () => done()));
    expect(await closeRehearsalChild(child)).toBe(true);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
  it("returns false on an unresponsive child and leaves further decisions to its owner", async () => {
    const child = new ChildProcess();
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    // A real Windows termination can take longer than this test deadline. The
    // portable timeout case must assert absent exit evidence, not OS scheduling.
    expect(await closeRehearsalChild(child, 20)).toBe(false);
    expect(kill).toHaveBeenCalledOnce();
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  });
  it.skipIf(process.platform === "win32")(
    "observes a real POSIX child ignoring termination",
    async () => {
      const child = spawn(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{}); console.log('ready');setInterval(()=>{},1000)"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      await new Promise<void>((done) => child.stdout!.once("data", () => done()));
      try {
        expect(await closeRehearsalChild(child, 20)).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await new Promise<void>((done) => child.once("exit", () => done()));
        }
      }
    },
  );
});
