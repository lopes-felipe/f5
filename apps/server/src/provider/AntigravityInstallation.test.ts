import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityInstallation } from "./AntigravityInstallation.ts";
import {
  resolveAntigravityReleaseAsset,
  type AntigravityReleaseAsset,
} from "./antigravityRelease.ts";

// Synthetic archive containing two tiny executable placeholders, never provider binaries.
const zip = Buffer.from(
  "UEsDBBQAAAAAAAAAIVwB2o7WCgAAAAoAAAADAAAAYWd5ZXhlY3V0YWJsZVBLAwQUAAAAAAAAACFc5DF0PQcAAAAHAAAABwAAAGhhcm5lc3NoYXJuZXNzUEsBAhQDFAAAAAAAAAAhXAHajtYKAAAACgAAAAMAAAAAAAAAAAAAAO2BAAAAAGFneVBLAQIUAxQAAAAAAAAAIVzkMXQ9BwAAAAcAAAAHAAAAAAAAAAAAAADtgSsAAABoYXJuZXNzUEsFBgAAAAACAAIAZgAAAFcAAAAAAA==",
  "base64",
);
const asset: AntigravityReleaseAsset = {
  version: "test",
  url: "https://example.invalid/release.zip",
  sha256: createHash("sha256").update(zip).digest("hex"),
  archiveBytes: zip.length,
  executable: { name: "agy", bytes: 10 },
  harness: { name: "harness", bytes: 7 },
};
const roots: string[] = [];
async function setup(overrides: Partial<AntigravityReleaseAsset> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "f5-antigravity-test-"));
  roots.push(root);
  return new AntigravityInstallation(root, { ...asset, ...overrides });
}
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Antigravity explicit installation", () => {
  it("resolves verified 1.3.0 assets for every supported platform including Intel Mac", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      for (const arch of ["arm64", "x64"]) {
        const release = resolveAntigravityReleaseAsset(platform, arch);
        expect(release?.version).toBe("1.3.0");
        expect(release?.url).toContain("1.3.0");
        expect(release?.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(release?.archiveBytes).toBeGreaterThan(0);
        expect(release?.executable.bytes).toBeGreaterThan(0);
        expect(release?.harness.bytes).toBeGreaterThan(0);
      }
    }
    expect(resolveAntigravityReleaseAsset("freebsd", "x64")).toBeNull();
  });
  it("does not download during status resolution and publishes only a verified complete release", async () => {
    const download = vi.fn(async () => new Response(zip));
    vi.stubGlobal("fetch", download);
    const install = await setup();
    await expect(install.resolve()).rejects.toThrow("Install Antigravity");
    expect(download).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([install.install(), install.install()]);
    expect(first).toEqual(second);
    expect(download).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(first.executablePath, "utf8")).toBe("executable");
    expect(await fs.readdir(install.directory)).toEqual([asset.sha256]);
    expect(await install.install()).toEqual(first);
    expect(download).toHaveBeenCalledTimes(1);
  });
  it("rejects a hash mismatch and removes its staging files", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(zip)),
    );
    const install = await setup({ sha256: "0".repeat(64) });
    await expect(install.install()).rejects.toThrow("integrity");
    expect(await fs.readdir(install.directory)).toEqual([]);
    await expect(install.resolve()).rejects.toThrow("Install Antigravity");
  });

  it("reports an existing release as needing an explicit update and keeps it usable during installation", async () => {
    const download = vi.fn(async () => new Response(zip));
    vi.stubGlobal("fetch", download);
    const install = await setup();
    const oldHash = "a".repeat(64);
    const oldDirectory = path.join(install.directory, oldHash);
    await fs.mkdir(oldDirectory, { recursive: true });
    await fs.writeFile(
      path.join(oldDirectory, "complete.json"),
      JSON.stringify({ sha256: oldHash, version: "1.1.1" }),
    );
    await fs.writeFile(path.join(oldDirectory, "running-harness"), "still in use");
    await expect(install.resolve()).rejects.toThrow("1.1.1 is installed. Update to test");
    expect(download).not.toHaveBeenCalled();
    const current = await install.install();
    expect(current.version).toBe("test");
    expect(await install.resolve()).toEqual(current);
    expect(await fs.readFile(path.join(oldDirectory, "running-harness"), "utf8")).toBe(
      "still in use",
    );
    expect(download).toHaveBeenCalledTimes(1);
  });
  it("cancels a stalled download without publishing or retaining partial files", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(stream) {
                stream.enqueue(zip.subarray(0, 10));
                started();
              },
            }),
          ),
      ),
    );
    const install = await setup();
    const pending = install.install(controller.signal);
    await ready;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(await fs.readdir(install.directory)).toEqual([]);
  });
  it("rejects expansion sizes that differ from the pinned release", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(zip)),
    );
    const install = await setup({ executable: { ...asset.executable, bytes: 9 } });
    await expect(install.install()).rejects.toThrow("Unexpected Antigravity archive entry");
    expect(await fs.readdir(install.directory)).toEqual([]);
  });
});
