import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createLidOwnership, processStart } from "./lidOwnership";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const canInspectProcesses =
  process.platform === "darwin" &&
  spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)]).status === 0;
describe.skipIf(!canInspectProcesses)("detached lid watchdog (requires process inspection)", () => {
  it.each(["dead", "replaced", "different-start"] as const)(
    "handles %s owner generation",
    async (scenario) => {
      const dir = await mkdtemp(join(tmpdir(), "f5-watchdog-"));
      directories.push(dir);
      const markerPath = join(dir, "marker.json");
      const log = join(dir, "reset");
      const sudo = join(dir, "sudo");
      const pmset = join(dir, "pmset");
      await writeFile(sudo, "#!/bin/sh\n/usr/bin/touch '" + log + "'\n", { mode: 0o700 });
      await writeFile(
        pmset,
        "#!/bin/sh\nprintf 'System-wide power settings:\\n SleepDisabled 0\\n'\n",
        { mode: 0o700 },
      );
      const ownership = createLidOwnership(markerPath, { sudo, pmset });
      const owner = spawn("/bin/sleep", ["30"]);
      try {
        const start = await processStart(owner.pid!);
        let marker = { ...(await ownership.newMarker()), ownerPid: owner.pid!, ownerStart: start };
        if (scenario === "different-start") marker.ownerStart = "different identity";
        await ownership.write(marker);
        marker = await ownership.armWatchdog(marker);
        if (scenario === "replaced") {
          await ownership.write({ ...marker, gen: "11111111-1111-4111-8111-111111111111" });
        }
        owner.kill();
        const deadline = Date.now() + 7000;
        while (Date.now() < deadline && (await ownership.watchdogAlive(marker)))
          await new Promise((resolve) => setTimeout(resolve, 100));
        await ownership.killWatchdog(marker);
        if (scenario === "replaced") {
          await expect(readFile(log)).rejects.toMatchObject({ code: "ENOENT" });
          expect(JSON.parse(await readFile(markerPath, "utf8")).gen).not.toBe(marker.gen);
        } else {
          await expect(readFile(log)).resolves.toBeDefined();
          await expect(readFile(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        owner.kill();
      }
    },
    10_000,
  );
});
