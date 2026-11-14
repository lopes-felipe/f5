import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { createBuildConfig } from "./build-desktop-artifact";
import { parseDesktopUpdateManifest } from "./desktop-update-manifest";
import { desktopReleaseAssets } from "./lib/release-profile";

// Exercise the pinned builder's real naming and metadata implementation,
// independently of native compilers and the hand-maintained release fixture.
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
builderRequire("app-builder-lib");
const { PlatformPackager } = appBuilderRequire("./out/platformPackager.js");
const { Platform } = appBuilderRequire("./out/core.js");
const { Arch } = appBuilderRequire("builder-util");
const { createUpdateInfoTasks, writeUpdateInfoFiles } = appBuilderRequire(
  "./out/publish/updateInfoBuilder.js",
);

it("electron-builder merges Linux artifact events into the exact feed the release verifier accepts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "f5-linux-feed-"));
  try {
    const version = "0.1.0-beta.1";
    const config = await Effect.runPromise(
      createBuildConfig("linux", "AppImage", "F5", false, false),
    );
    const linux = config.linux as { target: string[] };
    const packager = Object.assign(Object.create(PlatformPackager.prototype), {
      info: { config },
      appInfo: { version, productName: "F5", sanitizedProductName: "F5" },
      platform: Platform.LINUX,
      platformSpecificBuildOptions: linux,
      getResource: async () => null,
      emitArtifactCreated: async () => {},
    });
    const tasks: unknown[] = [];
    for (const extension of linux.target) {
      const name = packager.expandArtifactNamePattern({}, extension, Arch.x64);
      const file = join(directory, name);
      const content = Buffer.from(extension);
      await writeFile(file, content);
      tasks.push(
        ...(await createUpdateInfoTasks(
          {
            file,
            packager,
            arch: Arch.x64,
            target: { outDir: directory },
            updateInfo: {
              sha512: createHash("sha512").update(content).digest("base64"),
              size: content.length,
            },
          },
          [{ provider: "github", channel: "beta" }],
        )),
      );
    }
    await writeUpdateInfoFiles(tasks, packager);
    const feed = desktopReleaseAssets("all", version, "beta").feeds.find(
      (entry) => entry.manifest === "beta-linux.yml",
    )!;
    const parsed = parseDesktopUpdateManifest(
      await readFile(join(directory, feed.manifest), "utf8"),
      feed.manifest,
    );
    expect(parsed.version).toBe(version);
    expect(parsed.files.map((entry) => entry.url).sort()).toEqual([...feed.installers].sort());
    for (const entry of parsed.files) {
      const bytes = await readFile(join(directory, entry.url));
      expect(entry.size).toBe(bytes.length);
      expect(entry.sha512).toBe(createHash("sha512").update(bytes).digest("base64"));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
