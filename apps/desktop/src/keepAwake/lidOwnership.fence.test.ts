import { expect, it } from "vitest";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createLidOwnership, WATCHDOG } from "./lidOwnership";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForFile(path: string) {
  for (let i = 0; i < 200; i++) {
    try {
      await access(path);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error("Reset did not start");
}
it("fences restart until an in-flight reset child exits, even when it ignores termination", async () => {
  const dir = await mkdtemp(join(tmpdir(), "f5-watchdog-fence-"));
  const markerPath = join(dir, "marker");
  const flag = join(dir, "flag");
  const entered = join(dir, "entered");
  const sudo = join(dir, "sudo");
  const pmset = join(dir, "pmset");
  const ps = join(dir, "ps");
  // This behaves like a privileged child we cannot terminate. No real sudo,
  // power command, or process inspection is used by this integration test.
  await writeFile(
    sudo,
    "#!/bin/sh\ntrap '' TERM\n/usr/bin/touch '" +
      entered +
      "'\n/bin/sleep 0.4\nprintf 0 > '" +
      flag +
      "'\n",
    { mode: 0o700 },
  );
  await writeFile(
    pmset,
    "#!/bin/sh\nprintf 'System-wide power settings:\\n SleepDisabled 0\\n'\n",
    { mode: 0o700 },
  );
  await writeFile(ps, "#!/bin/sh\nprintf 'dead owner\\n'\n", { mode: 0o700 });
  const identity = async (pid: number) => {
    try {
      process.kill(pid, 0);
      return "test identity";
    } catch {
      return "";
    }
  };
  const ownership = createLidOwnership(markerPath, { sudo, pmset, ps }, identity);
  let marker = await ownership.newMarker();
  try {
    await ownership.write(marker);
    marker = await ownership.armWatchdog(marker);
    await waitForFile(entered);
    expect(JSON.parse(await readFile(markerPath, "utf8")).watchdogPid).toBe(marker.watchdogPid);
    await ownership.killWatchdog(marker);
    // killWatchdog must wait for the delayed write, not just the shell's death.
    expect(await readFile(flag, "utf8")).toBe("0");
    await ownership.remove();
    const next = await ownership.newMarker();
    await ownership.write(next);
    await writeFile(flag, "1");
    await delay(600);
    expect(await readFile(flag, "utf8")).toBe("1");
    expect(JSON.parse(await readFile(markerPath, "utf8")).gen).toBe(next.gen);
  } finally {
    await ownership.killWatchdog(marker);
    await rm(dir, { recursive: true, force: true });
  }
}, 5000);

it("refuses recovery from an untracked legacy watchdog", async () => {
  const ownership = createLidOwnership("/unused");
  await expect(
    ownership.killWatchdog({
      gen: "gen",
      ownerPid: 1,
      ownerStart: "owner",
      watchdogPid: 0,
      watchdogStart: "",
      engagedAt: 0,
    }),
  ).rejects.toThrow("manual intervention");
  await expect(
    ownership.killWatchdog({
      gen: "gen",
      ownerPid: 1,
      ownerStart: "owner",
      watchdogPid: 0,
      watchdogStart: "",
      engagedAt: 0,
      protocol: 2,
    }),
  ).resolves.toBeUndefined();
});

it("does not reset if the owner crashes before recording and committing the watchdog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "f5-watchdog-uncommitted-"));
  const marker = join(dir, "marker");
  const reset = join(dir, "reset");
  const sudo = join(dir, "sudo");
  const gen = "11111111-1111-4111-8111-111111111111";
  await writeFile(marker, JSON.stringify({ gen, watchdogPid: 0, protocol: 2 }));
  await writeFile(sudo, "#!/bin/sh\n/usr/bin/touch '" + reset + "'\n", { mode: 0o700 });
  const child = spawn(
    "/bin/sh",
    [
      "-c",
      WATCHDOG,
      "sh",
      "123",
      "dead owner",
      marker,
      gen,
      sudo,
      "/usr/bin/false",
      "/usr/bin/false",
    ],
    { stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", TZ: "UTC" } },
  );
  try {
    await once(child.stdout, "data");
    const exited = once(child, "exit");
    child.stdin.end(); // Simulates the main process closing its pipe on crash.
    await exited;
    await expect(access(reset)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(marker, "utf8")).watchdogPid).toBe(0);
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
}, 3000);
