// Stages the pinned Lima for macOS arm64 desktop builds (Linux VM profiles).
//
//   node scripts/stage-lima.ts --output <dir>
//
// Downloads the release tarball pinned in apps/desktop/vm-guest/lima.lock.json into a cache,
// verifies its SHA-256, and copies only what F5 runs into <dir>: `limactl`, the Linux guest
// agent, Lima's templates (limactl refuses to start without `default.yaml`, though F5 passes
// its own instance config) and the license. The macOS guest agent, the shell wrappers and the
// optional drivers and plugins in libexec are left out. The packaged app signs `limactl`.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = Path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const LIMA_LOCK_PATH = Path.join(root, "apps/desktop/vm-guest/lima.lock.json");

/** The tarball paths F5 ships, relative to its root. */
export const LIMA_STAGED_PATHS = [
  "bin/limactl",
  "share/lima/lima-guestagent.Linux-aarch64.gz",
  "share/lima/templates",
  "share/doc/lima/LICENSE",
] as const;

export interface LimaPin {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

export function parseLimaPin(value: unknown): LimaPin {
  const pin = value as Partial<LimaPin> | null;
  if (
    typeof pin?.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(pin.version) ||
    typeof pin.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(pin.sha256) ||
    !Number.isSafeInteger(pin.size) ||
    pin.size! <= 0 ||
    pin.url !==
      `https://github.com/lima-vm/lima/releases/download/v${pin.version}/lima-${pin.version}-Darwin-arm64.tar.gz`
  )
    throw new Error(`Invalid Lima pin in ${LIMA_LOCK_PATH}.`);
  return pin as LimaPin;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of FS.createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The cached tarball, downloaded and verified if it isn't there yet. */
async function cachedTarball(pin: LimaPin, cacheDir: string, fetchImpl: typeof fetch) {
  const tarball = Path.join(cacheDir, `lima-${pin.sha256}.tar.gz`);
  if (FS.existsSync(tarball) && (await sha256File(tarball)) === pin.sha256) return tarball;
  await FSP.mkdir(cacheDir, { recursive: true });
  const response = await fetchImpl(pin.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Downloading Lima failed (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength !== pin.size)
    throw new Error(`Lima download is ${bytes.byteLength} bytes; the pin says ${pin.size}.`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== pin.sha256) throw new Error("Lima download failed digest verification.");
  const part = `${tarball}.${process.pid}.part`;
  await FSP.writeFile(part, bytes);
  await FSP.rename(part, tarball);
  return tarball;
}

export async function stageLima(options: {
  readonly output: string;
  readonly cacheDir?: string;
  readonly lock?: unknown;
  readonly fetch?: typeof fetch;
}): Promise<LimaPin> {
  const pin = parseLimaPin(options.lock ?? JSON.parse(await FSP.readFile(LIMA_LOCK_PATH, "utf8")));
  const cacheDir = options.cacheDir ?? Path.join(root, "apps/desktop/dist-native/lima-cache");
  const tarball = await cachedTarball(pin, cacheDir, options.fetch ?? fetch);
  const extracted = await FSP.mkdtemp(Path.join(OS.tmpdir(), "f5-lima-"));
  try {
    const tar = spawnSync("tar", ["-xzf", tarball, "-C", extracted], { stdio: "inherit" });
    if (tar.error || tar.status !== 0) throw new Error("Extracting the Lima tarball failed.");
    await FSP.rm(options.output, { recursive: true, force: true });
    for (const relative of LIMA_STAGED_PATHS) {
      const source = Path.join(extracted, relative);
      if (!FS.existsSync(source)) throw new Error(`The Lima tarball has no ${relative}.`);
      await FSP.mkdir(Path.dirname(Path.join(options.output, relative)), { recursive: true });
      await FSP.cp(source, Path.join(options.output, relative), { recursive: true });
    }
    await FSP.chmod(Path.join(options.output, "bin/limactl"), 0o755);
  } finally {
    await FSP.rm(extracted, { recursive: true, force: true });
  }
  return pin;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const output = args.includes("--output") ? args[args.indexOf("--output") + 1] : undefined;
  if (!output) throw new Error("Usage: node scripts/stage-lima.ts --output <dir>");
  const pin = await stageLima({ output: Path.resolve(output) });
  console.log(`Staged Lima ${pin.version} in ${output}`);
}
