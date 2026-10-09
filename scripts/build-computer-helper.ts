import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const option = (name: string, fallback: string) =>
  args[args.indexOf(name) + 1] && args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
const platform = option(
  "--platform",
  process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux",
);
const arch = option("--arch", process.arch);
const strict = args.includes("--required") || args.includes("--check");
function run(command: string, argv: string[], cwd: string): boolean {
  const result = spawnSync(command, argv, { cwd, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    if (strict) throw new Error(`Computer helper build failed: ${command}`);
    console.warn(
      "Computer helper toolchain unavailable; computer control will report helper-missing.",
    );
    return false;
  }
  return true;
}
async function main(): Promise<void> {
  if (platform === "linux") {
    if (strict) throw new Error("Linux computer control is unsupported.");
    return;
  }
  if (!["mac", "win"].includes(platform) || !["arm64", "x64", "universal"].includes(arch))
    throw new Error("Expected --platform mac|win --arch arm64|x64|universal");
  const out = join(root, "apps/desktop/dist-native", `${platform}-${arch}`);
  mkdirSync(out, { recursive: true });
  const binary = join(out, platform === "win" ? "f5-computer-helper.exe" : "f5-computer-helper");
  if (platform === "mac") {
    const cwd = join(root, "apps/desktop/native/macos");
    const arches =
      arch === "universal" ? ["arm64", "x86_64"] : [arch === "x64" ? "x86_64" : "arm64"];
    const inputs: string[] = [];
    for (const architecture of arches) {
      const buildArgs = [
        "build",
        "-c",
        "release",
        "--arch",
        architecture,
        "--scratch-path",
        join(cwd, ".build", architecture),
      ];
      if (!run("swift", buildArgs, cwd)) return;
      const result = spawnSync("swift", [...buildArgs, "--show-bin-path"], {
        cwd,
        encoding: "utf8",
      });
      const input = join(result.stdout.trim(), "f5-computer-helper");
      if (!existsSync(input)) throw new Error("Swift build produced no helper.");
      inputs.push(input);
    }
    if (inputs.length === 1) copyFileSync(inputs[0]!, binary);
    else if (!run("lipo", ["-create", ...inputs, "-output", binary], cwd)) return;
  } else {
    if (arch === "universal") throw new Error("Windows requires one architecture.");
    const cwd = join(root, "apps/desktop/native/windows");
    const target = `${arch === "x64" ? "x86_64" : "aarch64"}-pc-windows-msvc`;
    if (!run("cargo", ["build", "--release", "--target", target], cwd)) return;
    copyFileSync(join(cwd, "target", target, "release", "f5-computer-helper.exe"), binary);
  }
  if (args.includes("--check")) {
    await new Promise<void>((accept, reject) => {
      const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
      let buffer = "";
      let hello = false;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Helper protocol check timed out."));
      }, 10_000);
      child.on("error", reject);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const message = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (message.type === "hello") {
            if (message.protocolVersion !== 1) {
              clearTimeout(timer);
              child.kill();
              reject(new Error("Helper protocol mismatch."));
              return;
            }
            hello = true;
            child.stdin.write('{"type":"permissions"}\n');
          }
          if (hello && message.type === "status") {
            clearTimeout(timer);
            child.stdin.end();
            child.kill();
            accept();
          }
        }
      });
    });
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
