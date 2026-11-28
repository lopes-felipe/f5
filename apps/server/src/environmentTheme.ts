import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, watch, type BigIntStats, type FSWatcher } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ServerSettings } from "@t3tools/contracts/settings";
import { ServerSettingsPatch } from "@t3tools/contracts/settings";
import { BUILTIN_THEME_IDS, THEME_TOKEN_NAMES } from "@t3tools/shared/themeTokens";
import { Effect, FileSystem, Path, Schema, Semaphore } from "effect";
import { sniffUploadImage } from "./attachmentUploads.ts";
import { isValidPublishedTheme, type ServerSettingsService } from "./serverSettings.ts";
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
            "Place <id>.webp, <id>.png, or <id>.jpg beside the published theme JSON. Use background-image: var(--theme-background-image) in the theme CSS. Removing a theme keeps its wallpaper file.",
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
      if (theme && !isValidPublishedTheme(theme))
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
      const copy = theme
        ? yield* writeFileStringAtomically({
            filePath: path.join(directory, theme.id + ".json"),
            contents: JSON.stringify(theme, null, 2),
          }).pipe(Effect.result)
        : undefined;
      const cleanup =
        remove && id
          ? yield* fs
              .remove(path.join(directory, id + ".json"), { force: true })
              .pipe(Effect.result)
          : undefined;
      return {
        themeId: id,
        appearance,
        directory,
        published: !!theme,
        removed: !!remove,
        ...(copy?._tag === "Failure" && theme
          ? {
              warning: "The theme is active, but its JSON copy could not be written.",
              wallpaperFilename: theme.id + ".webp",
            }
          : {}),
        ...(cleanup?._tag === "Failure"
          ? { warning: "The theme was removed, but its JSON copy could not be deleted." }
          : {}),
      };
    }).pipe(
      Effect.provideServices(services),
      Effect.mapError(keepThreadToolError("The environment theme could not be published.")),
      publishLock.withPermits(1),
    );
});

function backgroundRevision(stat: BigIntStats) {
  return [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join("-");
}

function supportedWallpaperMime(bytes: Uint8Array) {
  const mime = sniffUploadImage(bytes);
  return mime === "image/jpeg" || mime === "image/png" || mime === "image/webp" ? mime : null;
}

function absentWallpaper(error: unknown): null {
  if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
    return null;
  throw error;
}

export function makeEnvironmentThemeBackgrounds(directory: string) {
  const key = randomBytes(32);
  const sign = (id: string, revision: string) =>
    createHmac("sha256", key)
      .update(id + ":" + revision)
      .digest("hex");
  const canonicalDirectory = async () => {
    const parent = await realpath(dirname(directory)).catch(absentWallpaper);
    if (!parent) return null;
    const target = join(parent, basename(directory));
    return (await lstat(target).catch(absentWallpaper))?.isDirectory() ? target : null;
  };
  const fileRevision = async (target: string) => {
    const stat = await lstat(target, { bigint: true }).catch(absentWallpaper);
    return stat?.isFile() && stat.size > 0 && stat.size <= MAX_BACKGROUND_BYTES
      ? backgroundRevision(stat)
      : null;
  };
  const openWallpaper = (target: string) =>
    open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
      absentWallpaper,
    );
  let lastPaths: Readonly<Record<string, string>> = {};
  return {
    async watch(onChange: () => void) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const parent = await realpath(dirname(directory));
      const target = join(parent, basename(directory));
      let timer: ReturnType<typeof setTimeout> | undefined;
      let child: FSWatcher | undefined;
      let childIdentity: string | undefined;
      let closed = false;
      const notify = () => {
        clearTimeout(timer);
        timer = setTimeout(onChange, 150);
      };
      const detach = () => {
        child?.close();
        child = undefined;
        childIdentity = undefined;
      };
      const attach = async () => {
        const stat = await lstat(target, { bigint: true }).catch(absentWallpaper);
        if (closed) return;
        if (!stat?.isDirectory()) {
          detach();
          return;
        }
        const identity = String(stat.dev) + ":" + String(stat.ino);
        if (identity === childIdentity) return;
        detach();
        const watcher = watch(target, { persistent: false }, (_event, file) => {
          if (!file || /\.(webp|png|jpe?g)$/i.test(file)) notify();
        });
        watcher.on("error", () => {
          if (child === watcher) detach();
        });
        child = watcher;
        childIdentity = identity;
      };
      const watcher = watch(parent, { persistent: false }, (_event, file) => {
        if (file && file !== basename(directory)) return;
        void attach()
          .catch(() => undefined)
          .finally(() => {
            if (!closed) notify();
          });
      });
      watcher.on("error", () => watcher.close());
      await attach().catch(() => undefined);
      return () => {
        closed = true;
        clearTimeout(timer);
        child?.close();
        watcher.close();
      };
    },
    async paths(settings: ServerSettings): Promise<Record<string, string>> {
      if (!settings.environmentThemes.length) {
        lastPaths = {};
        return {};
      }
      const target = await canonicalDirectory().catch(() => undefined);
      if (!target) {
        const paths =
          target === null
            ? {}
            : Object.fromEntries(
                settings.environmentThemes.flatMap(({ id }) =>
                  lastPaths[id] ? [[id, lastPaths[id]]] : [],
                ),
              );
        lastPaths = paths;
        return paths;
      }
      const entries = await Promise.all(
        settings.environmentThemes.map(({ id }) =>
          (async () => {
            for (const extension of extensions) {
              const candidate = join(target, `${id}.${extension}`);
              const revision = await fileRevision(candidate);
              if (revision) {
                const file = await openWallpaper(candidate);
                if (!file) continue;
                try {
                  const header = Buffer.alloc(12);
                  const { bytesRead } = await file.read(header, 0, header.length, 0);
                  if (!supportedWallpaperMime(header.subarray(0, bytesRead))) continue;
                  if (backgroundRevision(await file.stat({ bigint: true })) !== revision) continue;
                } finally {
                  await file.close();
                }
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
          })().catch(() => (lastPaths[id] ? [[id, lastPaths[id]] as const] : [])),
        ),
      );
      const paths = Object.fromEntries(entries.flat());
      lastPaths = paths;
      return paths;
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
        const file = await openWallpaper(target);
        if (!file) continue;
        try {
          const stat = await file.stat({ bigint: true });
          if (extension + "-" + backgroundRevision(stat) !== revision) continue;
          if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BACKGROUND_BYTES) continue;
          const buffer = Buffer.alloc(Number(stat.size) + 1);
          let offset = 0;
          while (offset < buffer.length) {
            const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
            if (!bytesRead) break;
            offset += bytesRead;
          }
          if (
            offset !== Number(stat.size) ||
            backgroundRevision(await file.stat({ bigint: true })) !== backgroundRevision(stat)
          )
            continue;
          const bytes = buffer.subarray(0, offset);
          const mime = supportedWallpaperMime(bytes);
          if (mime) return { mime, bytes };
        } finally {
          await file.close();
        }
      }
      return null;
    },
  };
}
