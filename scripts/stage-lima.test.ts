import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { LIMA_LOCK_PATH, parseLimaPin, stageLima } from "./stage-lima.ts";

let dir: string;
beforeEach(() => {
  dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-stage-lima-"));
});
afterEach(() => {
  FS.rmSync(dir, { recursive: true, force: true });
});

/** A tarball laid out like Lima's release, including the parts F5 leaves out. */
function tarball(options: { omit?: string } = {}) {
  const tree = Path.join(dir, "tree");
  const files: Record<string, string> = {
    "bin/limactl": "mach-o",
    "bin/lima": "#!/bin/sh",
    "libexec/lima/lima-driver-krunkit": "driver",
    "share/lima/lima-guestagent.Linux-aarch64.gz": "linux agent",
    "share/lima/lima-guestagent.Darwin-aarch64.gz": "darwin agent",
    "share/lima/templates/default.yaml": "base: x",
    "share/doc/lima/LICENSE": "Apache-2.0",
  };
  for (const [relative, content] of Object.entries(files)) {
    if (relative === options.omit) continue;
    FS.mkdirSync(Path.dirname(Path.join(tree, relative)), { recursive: true });
    FS.writeFileSync(Path.join(tree, relative), content);
  }
  const archive = Path.join(dir, "lima.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", tree, "."]);
  const bytes = FS.readFileSync(archive);
  const lock = {
    version: "2.3.0",
    url: "https://github.com/lima-vm/lima/releases/download/v2.3.0/lima-2.3.0-Darwin-arm64.tar.gz",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
  const requests: string[] = [];
  const fetch = (async (url: string) => {
    requests.push(url);
    return new Response(bytes);
  }) as unknown as typeof globalThis.fetch;
  return { lock, fetch, requests };
}

const stage = (source: ReturnType<typeof tarball>, lock: unknown = source.lock) =>
  stageLima({
    output: Path.join(dir, "out"),
    cacheDir: Path.join(dir, "cache"),
    lock,
    fetch: source.fetch,
  });

const staged = () =>
  FS.readdirSync(Path.join(dir, "out"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      Path.relative(Path.join(dir, "out"), Path.join(entry.parentPath, entry.name)).replaceAll(
        Path.sep,
        "/",
      ),
    )
    .sort();

// Lima is staged only for macOS builds; Windows runners' tar takes `C:` for a remote host.
const posixTar = it.skipIf(process.platform === "win32");

posixTar("stages only limactl, the Linux guest agent, the templates and the license", async () => {
  const source = tarball();
  await stage(source);
  expect(staged()).toEqual([
    "bin/limactl",
    "share/doc/lima/LICENSE",
    "share/lima/lima-guestagent.Linux-aarch64.gz",
    "share/lima/templates/default.yaml",
  ]);
  // Windows applies no POSIX execute bits (the tarball tests skip there anyway).
  if (process.platform !== "win32")
    expect(FS.statSync(Path.join(dir, "out/bin/limactl")).mode & 0o111).not.toBe(0);
  // The verified tarball is cached: a second build doesn't download it again.
  await stage(source);
  expect(source.requests).toHaveLength(1);
});

posixTar("refuses a download that doesn't match the pin, caching nothing", async () => {
  const source = tarball();
  await expect(stage(source, { ...source.lock, sha256: "0".repeat(64) })).rejects.toThrow(
    /digest verification/,
  );
  await expect(stage(source, { ...source.lock, size: source.lock.size + 1 })).rejects.toThrow(
    /the pin says/,
  );
  expect(FS.readdirSync(Path.join(dir, "cache"))).toEqual([]);
});

posixTar("refuses a tarball missing a file F5 needs", async () => {
  await expect(stage(tarball({ omit: "share/lima/templates/default.yaml" }))).rejects.toThrow(
    /no share\/lima\/templates/,
  );
});

it("accepts only a Darwin arm64 release asset of lima-vm/lima", () => {
  const good = {
    version: "2.3.0",
    url: "https://github.com/lima-vm/lima/releases/download/v2.3.0/lima-2.3.0-Darwin-arm64.tar.gz",
    sha256: "a".repeat(64),
    size: 10,
  };
  expect(parseLimaPin(good)).toEqual(good);
  for (const patch of [
    {
      url: "https://github.com/someone/lima/releases/download/v2.3.0/lima-2.3.0-Darwin-arm64.tar.gz",
    },
    {
      url: "https://github.com/lima-vm/lima/releases/download/v2.3.0/lima-2.3.0-Darwin-x86_64.tar.gz",
    },
    { version: "2.3.1" },
    { sha256: "ABC" },
    { size: 0 },
  ])
    expect(() => parseLimaPin({ ...good, ...patch })).toThrow(/Invalid Lima pin/);
});

it("keeps a valid pin in the repository", () => {
  expect(() => parseLimaPin(JSON.parse(FS.readFileSync(LIMA_LOCK_PATH, "utf8")))).not.toThrow();
});
