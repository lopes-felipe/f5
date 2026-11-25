import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ServerSettings } from "@t3tools/contracts/settings";
import { ServerSettingsPatch } from "@t3tools/contracts/settings";
import { BUILTIN_THEME_IDS, THEME_TOKEN_NAMES } from "@t3tools/shared/themeTokens";
import { themeCssLoadsRemoteFiles } from "@t3tools/shared/themeCss";
import { Effect, FileSystem, Path, Schema, Semaphore } from "effect";
import { sniffUploadImage } from "./attachmentUploads.ts";
import type { ServerSettingsService } from "./serverSettings.ts";
import { writeFileStringAtomically } from "./atomicWrite.ts";
import {
  keepThreadToolError,
  ThreadToolError,
  type ThreadToolRequest,
} from "./mcp/threadMcpTools.ts";

export const THEME_BACKGROUND_ROUTE = "/api/theme-background/";
const MAX_BACKGROUND_BYTES = 16 * 1024 * 1024;
const extensions = ["webp", "png", "jpg", "jpeg"] as const;

export const makeEnvironmentThemeTools = Effect.fn(function* (
  directory: string,
  settings: ServerSettingsService["Service"],
) {
  const services = yield* Effect.services<FileSystem.FileSystem | Path.Path>();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const publishLock = yield* Semaphore.make(1);
  return (request: Extract<ThreadToolRequest, { name: "theme_read" | "theme_set" }>) =>
    Effect.gen(function* () {
      if (request.name === "theme_read") {
        const { environmentThemes, environmentThemeSelection } = yield* settings.getSettings;
        return {
          directory,
          current: environmentThemeSelection.theme?.value,
          appearance: environmentThemeSelection.appearance?.value,
          builtIn: BUILTIN_THEME_IDS,
          themes: environmentThemes.map(({ id, name, css }) => ({ id, name, hasCss: !!css })),
          colorTokens: THEME_TOKEN_NAMES,
          guide:
            "Place <id>.webp, <id>.png, or <id>.jpg beside the published theme JSON. Use background-image: var(--theme-background-image) in the theme CSS.",
        };
      }
      const { appearance, theme: input } = request.input;
      const id = request.input.themeId ?? input?.id;
      const theme = input ? { ...input, name: input.name.trim() } : undefined;
      const builtin = id ? (BUILTIN_THEME_IDS as readonly string[]).includes(id) : false;
      if ((!id && !appearance) || (theme && (theme.id !== id || builtin)))
        return yield* new ThreadToolError({
          message: "Supply an appearance, theme id, or theme definition with a matching custom id.",
        });
      if (
        theme &&
        (!theme.name ||
          (theme.css && themeCssLoadsRemoteFiles(theme.css)) ||
          Object.values(theme.overrides ?? {}).some((variant) =>
            Object.entries(variant ?? {}).some(
              ([token, color]) =>
                !(THEME_TOKEN_NAMES as readonly string[]).includes(token) ||
                !/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color),
            ),
          ))
      )
        return yield* new ThreadToolError({
          message:
            "Use a theme name, hexadecimal colors for F5 theme tokens, and CSS that does not load files.",
        });
      const update = settings.updateSettingsWith;
      if (!update)
        return yield* new ThreadToolError({ message: "Environment theme storage is unavailable." });
      if (theme) yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const generation = randomUUID();
      let refusal = "The published theme library exceeds its 2 MiB or 32 theme limit.";
      const updated = yield* update((current) => {
        if (
          id &&
          !theme &&
          !builtin &&
          !current.environmentThemes.some((entry) => entry.id === id)
        ) {
          refusal = "The requested theme has not been published.";
          return undefined;
        }
        const patch = {
          ...(theme
            ? {
                environmentThemes: [
                  ...current.environmentThemes.filter(({ id }) => id !== theme.id),
                  theme,
                ],
              }
            : {}),
          environmentThemeSelection: {
            ...current.environmentThemeSelection,
            ...(id ? { theme: { value: id, generation } } : {}),
            ...(appearance ? { appearance: { value: appearance, generation } } : {}),
          },
        };
        return Schema.is(ServerSettingsPatch)(patch) ? patch : undefined;
      });
      if (!updated)
        return yield* new ThreadToolError({
          message: refusal,
        });
      // The settings store owns publication. The copy on disk identifies where
      // the user can place <id>.webp, <id>.png, or <id>.jpg.
      if (theme)
        yield* writeFileStringAtomically({
          filePath: path.join(directory, theme.id + ".json"),
          contents: JSON.stringify(theme, null, 2),
        }).pipe(Effect.ignore);
      return { themeId: id, appearance, directory, published: !!theme };
    }).pipe(
      Effect.provideServices(services),
      Effect.mapError(keepThreadToolError("The environment theme could not be published.")),
      publishLock.withPermits(1),
    );
});

export function makeEnvironmentThemeBackgrounds(directory: string) {
  const key = randomBytes(32);
  const sign = (id: string) => createHmac("sha256", key).update(id).digest("hex");
  return {
    paths(settings: ServerSettings): Record<string, string> {
      return Object.fromEntries(
        settings.environmentThemes.map(({ id }) => [
          id,
          `${THEME_BACKGROUND_ROUTE}${id}?signature=${sign(id)}`,
        ]),
      );
    },
    async read(id: string, signature: string) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !/^[0-9a-f]{64}$/.test(signature)) return null;
      if (!timingSafeEqual(Buffer.from(sign(id)), Buffer.from(signature))) return null;
      // Only flat, regular raster files in the environment theme directory.
      const parent = await realpath(dirname(directory)).catch(() => null);
      if (!parent) return null;
      const canonicalDirectory = join(parent, basename(directory));
      if (!(await lstat(canonicalDirectory).catch(() => null))?.isDirectory()) return null;
      for (const extension of extensions) {
        const target = join(canonicalDirectory, `${id}.${extension}`);
        if (!(await lstat(target).catch(() => null))?.isFile()) continue;
        const file = await open(
          target,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        ).catch(() => null);
        if (!file) continue;
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BACKGROUND_BYTES) continue;
          const buffer = Buffer.alloc(stat.size + 1);
          let offset = 0;
          while (offset < buffer.length) {
            const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
            if (!bytesRead) break;
            offset += bytesRead;
          }
          if (offset > MAX_BACKGROUND_BYTES) continue;
          const bytes = buffer.subarray(0, offset);
          const mime = sniffUploadImage(bytes);
          if (mime === "image/jpeg" || mime === "image/png" || mime === "image/webp")
            return { mime, bytes };
        } finally {
          await file.close();
        }
      }
      return null;
    },
  };
}
