import { mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Target } from "./identity";
import { cleanEnvironment } from "./process";
import { record } from "./model";
import { prepareElectronFixture } from "./electronFixture";
import { prepareWindowsFixtures } from "./windowsFixtures";

export const FIXTURE_NAMES = [
  "ComputerControlFixture",
  "StopLatencyFixture",
  "CaptureVerifier",
  "ProtectionAppVerifier",
  "RealAppVerifier",
] as const;

/** Metadata-only probes; never launches apps, changes focus, captures or posts input. */
export async function probeFixtureProtocols(
  directory: string,
  executeFile: (
    binary: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
  ) => Promise<{ stdout: string | Buffer }> = promisify(execFile),
): Promise<boolean> {
  try {
    const options = { env: cleanEnvironment(), timeout: 5000, maxBuffer: 4096 };
    const processes: unknown = JSON.parse(
      (
        await executeFile(join(directory, "ProtectionAppVerifier"), ["--status"], options)
      ).stdout.toString(),
    );
    const apps: unknown = JSON.parse(
      (
        await executeFile(join(directory, "RealAppVerifier"), ["--status"], options)
      ).stdout.toString(),
    );
    return (
      record(processes) &&
      [
        "com.apple.Terminal",
        "com.google.Chrome",
        "com.apple.TextEdit",
        "com.apple.calculator",
      ].every(
        (id) =>
          Array.isArray(processes[id]) &&
          processes[id].every((pid: unknown) => Number.isSafeInteger(pid) && Number(pid) > 0),
      ) &&
      record(apps) &&
      typeof apps.textEditRunning === "boolean" &&
      typeof apps.calculatorRunning === "boolean"
    );
  } catch {
    return false;
  }
}
/** Compile once before readiness. Never starts an app, grant, permit or input. */
export async function prepareFixtures(target: Target, directory: string): Promise<boolean> {
  if (target.platform === "win32") return prepareWindowsFixtures(target, directory);
  if (process.platform !== "darwin" || target.platform !== "darwin") return false;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const exec = promisify(execFile);
  for (const name of FIXTURE_NAMES) {
    const output = join(directory, name);
    let exists = true;
    try {
      await access(output);
    } catch {
      exists = false;
    }
    if (exists) throw new Error("Fixture output already exists; choose a new suite directory");
    try {
      await exec(
        "swiftc",
        [
          "-framework",
          "AppKit",
          join(target.repo, "apps/desktop/native/macos/Fixtures", name + ".swift"),
          "-o",
          output,
        ],
        { env: cleanEnvironment(), timeout: 30000, maxBuffer: 16384 },
      );
    } catch {
      return false;
    }
  }
  if (!(await probeFixtureProtocols(directory))) return false;
  try {
    return await prepareElectronFixture(target.repo, directory);
  } catch {
    return false;
  }
}
