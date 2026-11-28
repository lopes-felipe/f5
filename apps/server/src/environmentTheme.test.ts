import { afterEach, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SERVER_SETTINGS, ServerSettingsPatch } from "@t3tools/contracts/settings";
import { Effect, Schema } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { makeEnvironmentThemeBackgrounds, makeEnvironmentThemeTools } from "./environmentTheme.ts";

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
  const settings = { ...DEFAULT_SERVER_SETTINGS, environmentThemes: [theme] };
  expect(await backgrounds.paths(settings)).toEqual({});
  const image = join(directory, theme.id + ".png");
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(image, png);
  await truncate(image, 16 * 1024 * 1024);
  await writeFile(join(directory, theme.id + ".webp"), "unrecognized image");
  const path = (await backgrounds.paths(settings))[theme.id]!;
  const params = new URL(path, "http://localhost").searchParams;
  const signature = params.get("signature")!;
  const revision = params.get("revision")!;
  expect((await backgrounds.read(theme.id, signature, revision))?.bytes.byteLength).toBe(
    16 * 1024 * 1024,
  );
  expect(await backgrounds.read(theme.id, "0".repeat(64), revision)).toBeNull();
  await writeFile(image, png);
  expect((await backgrounds.paths(settings))[theme.id]).not.toBe(path);
  expect(await backgrounds.read(theme.id, signature, revision)).toBeNull();
  await truncate(image, 16 * 1024 * 1024 + 1);
  expect(await backgrounds.paths(settings)).toEqual({});
  await rm(join(directory, theme.id + ".webp"));
  await writeFile(join(root, "outside.png"), png);
  await symlink(join(root, "outside.png"), join(directory, theme.id + ".webp"));
  expect(await backgrounds.paths(settings)).toEqual({});
});

it("allows 100,000 CSS characters and applies the 2 MiB published library budget", () => {
  const valid = Schema.is(ServerSettingsPatch);
  const large = { ...theme, css: ".".repeat(100_000) };
  expect(valid({ environmentThemes: [large] })).toBe(true);
  expect(valid({ environmentThemes: [theme, theme] })).toBe(false);
  expect(
    valid({ environmentThemes: [{ ...theme, overrides: { light: { background: "red" } } }] }),
  ).toBe(false);
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

it("notifies clients when an image is added, including after recreating the theme directory", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "f5-theme-watch-"));
  directories.push(root);
  const directory = join(root, "themes");
  const backgrounds = makeEnvironmentThemeBackgrounds(directory);
  let changes = 0;
  const stop = await backgrounds.watch(() => {
    changes += 1;
  });
  const waitForImageChange = (previous: number) =>
    expect
      .poll(
        async () => {
          // Some platforms begin delivering fs.watch events after watch() returns.
          if (changes === previous) await writeFile(join(directory, theme.id + ".png"), "image");
          return changes;
        },
        { timeout: 4_000, interval: 400 },
      )
      .toBeGreaterThan(previous);
  try {
    await waitForImageChange(0);
    const first = changes;
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory);
    await expect.poll(() => changes, { timeout: 4_000 }).toBeGreaterThan(first);
    await waitForImageChange(changes);
  } finally {
    stop();
  }
}, 15_000);

it("publishes and removes a theme without disturbing the appearance selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "f5-theme-set-"));
  directories.push(directory);
  let settings = DEFAULT_SERVER_SETTINGS;
  const tool = await Effect.runPromise(
    makeEnvironmentThemeTools(directory, {
      getSettings: Effect.sync(() => settings),
      updateSettingsWith: (input) =>
        Effect.sync(() => {
          const patch = typeof input === "function" ? input(settings) : input;
          if (!patch) return undefined;
          settings = applyServerSettingsPatch(settings, patch);
          return settings;
        }),
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  const set = (input: Extract<Parameters<typeof tool>[0], { name: "theme_set" }>["input"]) =>
    Effect.runPromise(tool({ name: "theme_set", input }));
  await expect(set({ themeId: theme.id })).rejects.toThrow("has not been published");
  await expect(set({ theme: { ...theme, id: "f5-black" } })).rejects.toThrow("matching custom id");
  await expect(
    set({ theme: { ...theme, css: "a{background:url(https://example.test/image)}" } }),
  ).rejects.toThrow("CSS that does not load files");
  await set({ theme, appearance: "dark" });
  const jsonPath = join(directory, theme.id + ".json");
  const wallpaperPath = join(directory, theme.id + ".png");
  expect(JSON.parse(await readFile(jsonPath, "utf8"))).toEqual(theme);
  await writeFile(wallpaperPath, "image");
  const appearance = settings.environmentThemeSelection.appearance;
  expect(settings.environmentThemes).toEqual([theme]);
  await set({ themeId: theme.id, remove: true });
  expect(settings.environmentThemes).toEqual([]);
  expect(settings.environmentThemeSelection).toEqual({ appearance });
  await expect(readFile(jsonPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(wallpaperPath, "utf8")).toBe("image");
});
