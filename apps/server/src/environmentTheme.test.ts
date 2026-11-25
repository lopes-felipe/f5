import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SERVER_SETTINGS, ServerSettingsPatch } from "@t3tools/contracts/settings";
import { Schema } from "effect";
import { makeEnvironmentThemeBackgrounds } from "./environmentTheme.ts";

const theme = {
  version: 1,
  id: "custom-theme",
  name: "Custom theme",
  parameters: { baseHue: 240, chroma: 0.15, contrast: 1 },
} as const;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("authorizes a full-size theme background and rejects a forged URL or linked file", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "f5-themes-test-"));
  directories.push(root);
  const directory = join(root, "themes");
  await mkdir(directory);
  const backgrounds = makeEnvironmentThemeBackgrounds(directory);
  const path = backgrounds.paths({ ...DEFAULT_SERVER_SETTINGS, environmentThemes: [theme] })[
    theme.id
  ]!;
  const signature = new URL(path, "http://localhost").searchParams.get("signature")!;
  const image = join(directory, theme.id + ".png");
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(image, png);
  await truncate(image, 16 * 1024 * 1024);
  expect((await backgrounds.read(theme.id, signature))?.bytes.byteLength).toBe(16 * 1024 * 1024);
  expect(await backgrounds.read(theme.id, "0".repeat(64))).toBeNull();
  await truncate(image, 16 * 1024 * 1024 + 1);
  expect(await backgrounds.read(theme.id, signature)).toBeNull();
  await writeFile(join(root, "outside.png"), png);
  await symlink(join(root, "outside.png"), join(directory, theme.id + ".webp"));
  expect(await backgrounds.read(theme.id, signature)).toBeNull();
});

it("allows 100,000 CSS characters and applies the 2 MiB published library budget", () => {
  const valid = Schema.is(ServerSettingsPatch);
  const large = { ...theme, css: ".".repeat(100_000) };
  expect(valid({ environmentThemes: [large] })).toBe(true);
  expect(valid({ environmentThemes: [{ ...large, css: large.css + "." }] })).toBe(false);
  expect(
    valid({
      environmentThemes: Array.from({ length: 22 }, (_, index) => ({
        ...large,
        id: "theme-" + index,
      })),
    }),
  ).toBe(false);
});
