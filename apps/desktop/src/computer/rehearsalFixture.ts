import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, basename, dirname, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { computerFixturePerformanceArgs } from "./computerInspectionRehearsal";

export async function prepareRehearsalExecutable(
  source: string,
  output: string,
  preparedDirectory?: string,
) {
  if (preparedDirectory)
    await copyFile(join(preparedDirectory, basename(source, ".swift")), output);
  else
    await promisify(execFile)("swiftc", ["-framework", "AppKit", source, "-o", output], {
      timeout: 30000,
    });
}

/** A temporary app containing synthetic content only; never adopts a user app. */
export async function createRehearsalFixture(options: {
  root: string;
  appId: string;
  ungranted?: boolean;
  background?: boolean;
  displayId?: string;
  executableSource?: string;
  expectedText?: string;
  sourceFile?: string;
  observeChord?: boolean;
  diagnoseChord?: boolean;
  passiveChord?: boolean;
  preparedDirectory?: string;
  treeNodes?: number;
  delayedFocus?: boolean;
  /** macOS only: adds a self-dismissing button and a Cmd+N second window. */
  recoveryChecks?: boolean;
  onChild?: (child: ChildProcessByStdio<Writable, Readable, Readable | null>) => void;
}) {
  if (process.platform === "win32") {
    if (!options.preparedDirectory || options.passiveChord || options.displayId)
      throw new Error(
        "Windows fixture requires prepared binaries; chord/display drivers are separate.",
      );
    const executable = resolve(options.appId);
    const within = relative(resolve(options.root), executable);
    if (isAbsolute(within) || within.startsWith("..") || !within || !executable.endsWith(".exe"))
      throw new Error("Windows fixture must be inside its isolated rehearsal directory.");
    await mkdir(dirname(executable), { recursive: true });
    await copyFile(join(options.preparedDirectory, "ComputerControlFixture.exe"), executable);
    const child = spawn(
      executable,
      options.observeChord
        ? ["--run-stop"]
        : ["--run", ...(options.ungranted ? ["--ungranted"] : [])],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    options.onChild?.(child);
    const fixture = await observeRehearsalFixture(child, executable);
    return configureWindowsPerformanceFixture(fixture, options);
  }
  if (options.displayId !== undefined && !/^\d{1,10}$/.test(options.displayId))
    throw new Error("Invalid fixture display id.");
  const contents = join(options.root, options.appId, "Fixture.app", "Contents");
  const executable = join(contents, "MacOS", "Fixture");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await writeFile(
    join(contents, "Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${options.appId}</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>Computer Control Test Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>NSPrincipalClass</key><string>NSApplication</string><key>LSMinimumSystemVersion</key><string>14.0</string></dict></plist>`,
  );
  if (options.executableSource) await copyFile(options.executableSource, executable);
  else
    await prepareRehearsalExecutable(
      options.sourceFile ??
        resolve(import.meta.dirname, "../../native/macos/Fixtures/ComputerControlFixture.swift"),
      executable,
      options.preparedDirectory,
    );
  const args = [
    ...computerFixturePerformanceArgs(options),
    ...(options.background ? ["--background"] : []),
    ...(options.displayId ? ["--display-id", options.displayId] : []),
    ...(options.ungranted ? ["--ungranted"] : []),
    ...(options.expectedText ? ["--expected-text", options.expectedText] : []),
    ...(options.observeChord ? ["--observe-chord"] : []),
    ...(options.diagnoseChord ? ["--diagnose-chord"] : []),
    ...(options.passiveChord ? ["--passive-chord"] : []),
    ...(options.recoveryChecks ? ["--recovery-checks"] : []),
  ];
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "ignore"] });
  options.onChild?.(child);
  return observeRehearsalFixture(child, executable);
}

/** Full Windows reset removes performance controls; rebuild them outside every timed sample. */
export async function configureWindowsPerformanceFixture<
  T extends {
    reset(): Promise<void>;
    command(command: string, receipt: string): Promise<void>;
  },
>(fixture: T, options: { treeNodes?: number; delayedFocus?: boolean }) {
  const configure = async () => {
    if (options.treeNodes)
      await fixture.command("performance-tree " + options.treeNodes, "FIXTURE_TREE_READY");
    if (options.delayedFocus)
      await fixture.command("performance-delayed-input", "FIXTURE_DELAYED_INPUT_READY");
  };
  await configure();
  return {
    ...fixture,
    reset: async () => {
      await fixture.reset();
      await configure();
    },
  };
}

/** Bounded synthetic receipts shared by AppKit and Chromium fixtures. */
export async function observeRehearsalFixture(
  child: ChildProcessByStdio<Writable, Readable, Readable | null>,
  executable: string,
) {
  let presses = 0;
  let typed = false;
  let acknowledged = false;
  let entered = false;
  let resets = 0;
  let factsVersion = 0;
  let facts = { presses: 0, expectedText: false, entered: false };
  const receipts = new Map<string, number>();
  const wait = async (condition: () => boolean) => {
    const deadline = performance.now() + 3000;
    while (!condition()) {
      if (performance.now() >= deadline) throw new Error("Synthetic fixture command timed out.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  let buffer = "";
  const ready = new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic fixture startup timed out.")), 5000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Synthetic fixture exited before becoming ready."));
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 8192) {
        clearTimeout(timer);
        reject(new Error("Synthetic fixture receipt overflow."));
        child.kill();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        receipts.set(line, (receipts.get(line) ?? 0) + 1);
        if (receipts.size > 100) receipts.delete(receipts.keys().next().value!);
        if (line.startsWith("{")) {
          try {
            const value = JSON.parse(line);
            const state =
              value.kind === "status"
                ? value.state
                : value.kind === "observation"
                  ? value.state?.receipt
                  : value;
            if (
              typeof state?.presses === "number" &&
              (typeof state.expectedText === "boolean" ||
                typeof state.expectedSyntheticTextReceived === "boolean")
            ) {
              facts = {
                presses: state.presses,
                expectedText: state.expectedText ?? state.expectedSyntheticTextReceived,
                entered,
              };
              factsVersion++;
            }
          } catch {
            /* Only bounded synthetic receipts are meaningful. */
          }
        }
        if (line === "FIXTURE_READY") {
          clearTimeout(timer);
          done();
        } else if (line === "FIXTURE_PRESSED") presses++;
        else if (line === "FIXTURE_TYPED") typed = true;
        else if (line === "FIXTURE_ACKNOWLEDGED") acknowledged = true;
        else if (line === "FIXTURE_ENTERED") entered = true;
        else if (line === "FIXTURE_RESET") {
          resets++;
          presses = 0;
          typed = false;
          entered = false;
        }
      }
    });
  });
  try {
    await ready;
  } catch (error) {
    child.kill();
    throw error;
  }
  return {
    child,
    executable,
    presses: () => presses,
    typed: () => typed,
    acknowledged: () => acknowledged,
    entered: () => entered,
    /** How many times a bounded synthetic receipt line has been seen. */
    receipt: (line: string) => receipts.get(line) ?? 0,
    command: async (command: string, receipt: string) => {
      const before = receipts.get(receipt) ?? 0;
      child.stdin.write(command + "\n");
      await wait(() => (receipts.get(receipt) ?? 0) > before);
    },
    verify: async () => {
      const before = factsVersion;
      child.stdin.write(process.platform === "win32" ? "status\n" : "PERF_VERIFY\n");
      await wait(() => factsVersion > before);
      return { ...facts, entered };
    },
    reset: async () => {
      const before = resets;
      child.stdin.write(process.platform === "win32" ? "performance-reset\n" : "PERF_RESET\n");
      const deadline = performance.now() + 2000;
      while (resets === before) {
        if (performance.now() >= deadline) throw new Error("Fixture reset timed out.");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}
