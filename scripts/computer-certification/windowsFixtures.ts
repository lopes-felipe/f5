import { access, copyFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { Target } from "./identity";
import { cleanEnvironment } from "./process";
import { record } from "./model";
import { prepareElectronFixture } from "./electronFixture";

export const WINDOWS_FIXTURE_BINARY = "ComputerControlFixture.exe";
export function windowsFixtureMetadata(value: unknown): boolean {
  return (
    record(value) &&
    value.protocolVersion === 1 &&
    value.fixtureVersion === "1.0.0" &&
    value.platform === "win32" &&
    value.kind === "synthetic-native-window" &&
    value.windowCreated === false &&
    value.nativeInputAvailable === false
  );
}
export async function probeWindowsFixture(
  directory: string,
  executeFile: (
    binary: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; windowsHide: boolean },
  ) => Promise<{ stdout: string | Buffer }> = promisify(execFile),
) {
  try {
    const output = await executeFile(join(directory, WINDOWS_FIXTURE_BINARY), ["--check"], {
      env: cleanEnvironment(),
      timeout: 5000,
      maxBuffer: 4096,
      windowsHide: true,
    });
    return windowsFixtureMetadata(JSON.parse(output.stdout.toString()));
  } catch {
    return false;
  }
}
/** Build-only preparation on the actual Windows host. The metadata branch cannot
 * create a window or inject input. Operator phases still require their own drivers. */
export async function prepareWindowsFixtures(target: Target, directory: string) {
  if (process.platform !== "win32" || target.platform !== "win32") return false;
  const root = join(target.repo, "apps/desktop/native/windows/fixture");
  const architecture = (target.arch ?? process.arch) === "arm64" ? "aarch64" : "x86_64";
  const triple = architecture + "-pc-windows-msvc";
  const output = join(directory, WINDOWS_FIXTURE_BINARY);
  try {
    await access(output);
    throw new Error("Fixture output already exists; choose a new suite directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await promisify(execFile)(
      "cargo",
      [
        "build",
        "--release",
        "--locked",
        "--manifest-path",
        join(root, "Cargo.toml"),
        "--target",
        triple,
      ],
      {
        env: cleanEnvironment(),
        timeout: 300000,
        maxBuffer: 65536,
        windowsHide: true,
      },
    );
    await copyFile(join(root, "target", triple, "release/f5-computer-fixture.exe"), output);
    return (
      (await probeWindowsFixture(directory)) &&
      (await prepareElectronFixture(target.repo, directory))
    );
  } catch {
    return false;
  }
}
