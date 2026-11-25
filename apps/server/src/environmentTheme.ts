import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, watch } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
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
  settings: Pick<ServerSettingsService["Service"], "getSettings" | "updateSettingsWith">,
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
      const { appearance, remove, theme: input } = request.input;
      const id = request.input.themeId ?? input?.id;
      const theme = input ? { ...input, name: input.name.trim() } : undefined;
      const builtin = id ? (BUILTIN_THEME_IDS as readonly string[]).includes(id) : false;
      if (remove && (!id || builtin || theme || appearance))
        return yield* new ThreadToolError({
          message: "Removal requires only the id of a published theme.",
        });
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
        if (remove) {
          const { theme: selected, ...selection } = current.environmentThemeSelection;
          return {
            environmentThemes: current.environmentThemes.filter((entry) => entry.id !== id),
            environmentThemeSelection:
              selected?.value === id ? selection : current.environmentThemeSelection,
          };
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
      return { themeId: id, appearance, directory, published: !!theme, removed: !!remove };
    }).pipe(
      Effect.provideServices(services),
      Effect.mapError(keepThreadToolError("The environment theme could not be published.")),
      publishLock.withPermits(1),
    );
});

export function makeEnvironmentThemeBackgrounds(directory: string) {
  const key = randomBytes(32);
  const sign = (id: string, revision: string) =>
    createHmac("sha256", key)
      .update(id + ":" + revision)
      .digest("hex");
  const canonicalDirectory = async () => {
    const parent = await realpath(dirname(directory)).catch(() => null);
    if (!parent) return null;
    const target = join(parent, basename(directory));
    return (await lstat(target).catch(() => null))?.isDirectory() ? target : null;
  };
  const fileRevision = async (target: string) => {
    const stat = await lstat(target, { bigint: true }).catch(() => null);
    return stat?.isFile() && stat.size > 0 && stat.size <= MAX_BACKGROUND_BYTES
      ? [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join("-")
      : null;
  };
  return {
    async watch(onChange: () => void) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = await canonicalDirectory();
      if (!target) return () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const watcher = watch(target, { persistent: false }, (_event, file) => {
        if (file && !/\.(webp|png|jpe?g)$/i.test(file)) return;
        clearTimeout(timer);
        timer = setTimeout(onChange, 150);
      });
      watcher.on("error", () => watcher.close());
      return () => {
        clearTimeout(timer);
        watcher.close();
      };
    },
    async paths(settings: ServerSettings): Promise<Record<string, string>> {
      if (!settings.environmentThemes.length) return {};
      const target = await canonicalDirectory();
      if (!target) return {};
      const entries = await Promise.all(
        settings.environmentThemes.map(async ({ id }) => {
          for (const extension of extensions) {
            const revision = await fileRevision(join(target, `${id}.${extension}`));
            if (revision) {
              const version = extension + "-" + revision;
              return [
                [
                  id,
                  `${THEME_BACKGROUND_ROUTE}${id}?revision=${version}&signature=${sign(id, version)}`,
                ] as const,
              ];
            }
          }
          return [];
        }),
      );
      return Object.fromEntries(entries.flat());
    },
    async read(id: string, signature: string, revision: string) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !/^[0-9a-f]{64}$/.test(signature)) return null;
      if (!timingSafeEqual(Buffer.from(sign(id, revision)), Buffer.from(signature))) return null;
      const directory = await canonicalDirectory();
      if (!directory) return null;
      for (const extension of extensions) {
        if (!revision.startsWith(extension + "-")) continue;
        const target = join(directory, `${id}.${extension}`);
        if (extension + "-" + (await fileRevision(target)) !== revision) continue;
        const file = await open(
          target,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        ).catch(() => null);
        if (!file) continue;
        try {
          const stat = await file.stat({ bigint: true });
          if (
            extension + "-" + [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join("-") !==
            revision
          )
            continue;
          if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BACKGROUND_BYTES) continue;
          const buffer = Buffer.alloc(Number(stat.size) + 1);
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
