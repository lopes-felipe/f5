import { expect, it, vi } from "vitest";
import { cleanupComputerRehearsal, interruptComputerRehearsal } from "./computerLifecycle";
import { mkdtemp, mkdir, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("removes owned scratch and output placeholder even when resource cleanup throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "f5-interrupt-test-"));
  const scratch = join(root, "scratch"),
    output = join(root, "report.json");
  try {
    await mkdir(scratch);
    await writeFile(output, "", { flag: "wx" });
    const exit = vi.fn();
    await interruptComputerRehearsal(
      async () => {
        throw new Error("suspend failed");
      },
      scratch,
      output,
      exit,
    );
    await expect(access(scratch)).rejects.toThrow();
    await expect(access(output)).rejects.toThrow();
    // A subsequent run may reserve the exact same output path.
    await writeFile(output, "", { flag: "wx" });
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("continues cleanup after throwing and hanging callbacks", async () => {
  vi.useFakeTimers();
  const closed: string[] = [];
  try {
    const cleanup = cleanupComputerRehearsal(
      [
        { name: "suspend", run: () => new Promise(() => {}) },
        {
          name: "close",
          run: () => {
            throw new Error("private");
          },
        },
        {
          name: "fixture",
          run: () => {
            closed.push("fixture");
          },
        },
        {
          name: "placeholder",
          run: () => {
            closed.push("placeholder");
          },
        },
      ],
      20,
    );
    await vi.advanceTimersByTimeAsync(25);
    expect(await cleanup).toEqual(["suspend", "close"]);
    expect(closed).toEqual(["fixture", "placeholder"]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
