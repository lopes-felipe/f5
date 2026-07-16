import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { symlinkSync } from "node:fs";

import { ProviderDriverKind, type CodexSettings } from "@t3tools/contracts";
import { Effect, FileSystem, Path, Schema } from "effect";
import * as PlatformError from "effect/PlatformError";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { expandHomePath } from "../../pathExpansion.ts";

export interface CodexHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string | undefined;
  readonly continuationKey: string;
}

const KNOWN_SHARED_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "sqlite",
  "shell_snapshots",
  "worktrees",
  "skills",
  "plugins",
  "cache",
  "logs",
] as const;

const PRIVATE_ENTRY_NAMES = new Set(["auth.json", "models_cache.json"]);
export const CODEX_SHADOW_MANAGED_FILES_MANIFEST = ".f5-managed-codex-files.json";
const SHADOW_LOCAL_ENTRY_NAMES = new Set([
  "log",
  "memories",
  "tmp",
  CODEX_SHADOW_MANAGED_FILES_MANIFEST,
]);

export interface MaterializeCodexShadowHomeOptions {
  readonly platform?: NodeJS.Platform;
  /** @internal Test hook for exercising the cross-volume copy path on one-volume CI hosts. */
  readonly forceWindowsFileCopy?: boolean;
}

interface ManagedFileFingerprint {
  readonly dev: string;
  readonly ino: string | null;
  readonly size: string;
  readonly mtimeMs: number | null;
}

interface ManagedFileEntry {
  readonly target: string;
  readonly kind: "hardLink" | "copy";
  readonly fingerprint: ManagedFileFingerprint;
}

interface ManagedFileManifest {
  readonly version: 1;
  readonly files: Record<string, ManagedFileEntry>;
}

function resolveHomePath(path: Path.Path, value: string | undefined): string {
  const expanded =
    value && value.trim().length > 0
      ? expandHomePath(value)
      : path.join(NodeOS.homedir(), ".codex");
  return path.resolve(expanded);
}

export const resolveCodexHomeLayout = Effect.fn("resolveCodexHomeLayout")(function* (
  config: CodexSettings,
): Effect.fn.Return<CodexHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const sharedHomePath = resolveHomePath(path, config.homePath);
  const shadowHomePath = config.shadowHomePath.trim();
  if (shadowHomePath.length === 0) {
    return {
      mode: "direct",
      sharedHomePath,
      effectiveHomePath: config.homePath.trim().length > 0 ? sharedHomePath : undefined,
      continuationKey: `codex:home:${sharedHomePath}`,
    };
  }

  const effectiveHomePath = path.resolve(expandHomePath(shadowHomePath));
  return {
    mode: "authOverlay",
    sharedHomePath,
    effectiveHomePath,
    continuationKey: `codex:home:${sharedHomePath}`,
  };
});

export class CodexShadowHomeError extends Schema.TaggedErrorClass<CodexShadowHomeError>()(
  "CodexShadowHomeError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

type LinkState =
  | {
      readonly _tag: "Missing";
    }
  | {
      readonly _tag: "NotSymlink";
    }
  | {
      readonly _tag: "Symlink";
      readonly target: string;
    }
  | {
      readonly _tag: "HardLink";
    };

function toShadowHomeError(cause: unknown): CodexShadowHomeError {
  return Schema.is(CodexShadowHomeError)(cause)
    ? cause
    : new CodexShadowHomeError({
        detail: "Failed to materialize Codex shadow home.",
        cause,
      });
}

function normalizeShadowHomeError<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, CodexShadowHomeError, R> {
  return effect.pipe(Effect.mapError(toShadowHomeError));
}

function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

function platformErrorCode(error: PlatformError.PlatformError): string | undefined {
  const cause = error.reason.cause;
  return typeof cause === "object" && cause !== null && "code" in cause
    ? String(cause.code)
    : undefined;
}

export function normalizeWindowsLinkPath(value: string): string {
  const withoutNamespace = value.replace(/^\\\\\?\\UNC\\/iu, "\\\\").replace(/^\\\\\?\\/u, "");
  const normalized = NodePath.win32.normalize(withoutNamespace);
  const root = NodePath.win32.parse(normalized).root;
  return (
    normalized.length > root.length ? normalized.replace(/[\\/]+$/u, "") : normalized
  ).toLowerCase();
}

function linksResolveToSameTarget(
  existing: string,
  target: string,
  link: string,
  platform: NodeJS.Platform,
): boolean {
  const resolvedExisting = NodePath.resolve(NodePath.dirname(link), existing);
  return platform === "win32"
    ? normalizeWindowsLinkPath(resolvedExisting) === normalizeWindowsLinkPath(target)
    : resolvedExisting === target;
}

function isManagedFileManifest(value: unknown): value is ManagedFileManifest {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as { readonly version?: unknown; readonly files?: unknown };
  if (manifest.version !== 1 || typeof manifest.files !== "object" || manifest.files === null) {
    return false;
  }
  return Object.values(manifest.files).every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const candidate = entry as Partial<ManagedFileEntry>;
    const fingerprint = candidate.fingerprint as Partial<ManagedFileFingerprint> | undefined;
    return (
      typeof candidate.target === "string" &&
      (candidate.kind === "hardLink" || candidate.kind === "copy") &&
      typeof fingerprint === "object" &&
      fingerprint !== null &&
      typeof fingerprint.dev === "string" &&
      (typeof fingerprint.ino === "string" || fingerprint.ino === null) &&
      typeof fingerprint.size === "string" &&
      (typeof fingerprint.mtimeMs === "number" || fingerprint.mtimeMs === null)
    );
  });
}

function fileFingerprint(info: FileSystem.File.Info): ManagedFileFingerprint {
  return {
    dev: String(info.dev),
    ino: info.ino === undefined ? null : String(info.ino),
    size: String(info.size),
    mtimeMs: info.mtime?.getTime() ?? null,
  };
}

function fingerprintsMatch(left: ManagedFileFingerprint, right: ManagedFileFingerprint): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

const readManagedFileManifest = Effect.fn("CodexHomeLayout.readManagedFileManifest")(function* (
  fileSystem: FileSystem.FileSystem,
  shadowPath: string,
): Effect.fn.Return<ManagedFileManifest, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const manifestPath = path.join(shadowPath, CODEX_SHADOW_MANAGED_FILES_MANIFEST);
  const contents = yield* fileSystem.readFileString(manifestPath).pipe(Effect.result);
  if (contents._tag === "Failure") {
    if (contents.failure.reason._tag === "NotFound") {
      return { version: 1, files: {} };
    }
    return yield* toShadowHomeError(contents.failure);
  }

  const parsed = yield* Effect.try({
    try: () => JSON.parse(contents.success) as unknown,
    catch: (cause) =>
      new CodexShadowHomeError({
        detail: `Cannot read Codex shadow-home ownership manifest '${manifestPath}'.`,
        cause,
      }),
  });
  if (!isManagedFileManifest(parsed)) {
    return yield* new CodexShadowHomeError({
      detail: `Codex shadow-home ownership manifest '${manifestPath}' is malformed.`,
    });
  }
  return parsed;
});

const trackManagedWindowsFile = Effect.fn("CodexHomeLayout.trackManagedWindowsFile")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly shadowPath: string;
    readonly entryName: string;
    readonly target: string;
    readonly link: string;
    readonly kind: ManagedFileEntry["kind"];
  }): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
    const path = yield* Path.Path;
    const manifest = yield* readManagedFileManifest(input.fileSystem, input.shadowPath);
    const info = yield* normalizeShadowHomeError(input.fileSystem.stat(input.link));
    const next: ManagedFileManifest = {
      version: 1,
      files: {
        ...manifest.files,
        [input.entryName]: {
          target: normalizeWindowsLinkPath(input.target),
          kind: input.kind,
          fingerprint: fileFingerprint(info),
        },
      },
    };
    yield* normalizeShadowHomeError(
      writeFileStringAtomically({
        filePath: path.join(input.shadowPath, CODEX_SHADOW_MANAGED_FILES_MANIFEST),
        contents: `${JSON.stringify(next, null, 2)}\n`,
      }).pipe(Effect.provideService(FileSystem.FileSystem, input.fileSystem)),
    );
  },
);

const isOwnedManagedWindowsFile = Effect.fn("CodexHomeLayout.isOwnedManagedWindowsFile")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly shadowPath: string;
    readonly entryName: string;
    readonly target: string;
    readonly link: string;
  }): Effect.fn.Return<boolean, CodexShadowHomeError, Path.Path> {
    const manifest = yield* readManagedFileManifest(input.fileSystem, input.shadowPath);
    const entry = manifest.files[input.entryName];
    if (!entry || entry.target !== normalizeWindowsLinkPath(input.target)) return false;
    const info = yield* normalizeShadowHomeError(input.fileSystem.stat(input.link));
    return fingerprintsMatch(entry.fingerprint, fileFingerprint(info));
  },
);

const readLinkState = Effect.fn("CodexHomeLayout.readLinkState")(function* (
  fileSystem: FileSystem.FileSystem,
  linkPath: string,
  targetPath?: string,
  platform: NodeJS.Platform = process.platform,
): Effect.fn.Return<LinkState, CodexShadowHomeError> {
  return yield* fileSystem.readLink(linkPath).pipe(
    Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (error.reason._tag === "NotFound") {
          return { _tag: "Missing" } as LinkState;
        }
        if (isNotSymlinkError(error)) {
          if (platform === "win32" && targetPath) {
            const stats = yield* Effect.all(
              [fileSystem.stat(linkPath), fileSystem.stat(targetPath)],
              { concurrency: "unbounded" },
            ).pipe(Effect.option);
            if (
              stats._tag === "Some" &&
              stats.value[0].type === "File" &&
              stats.value[1].type === "File" &&
              stats.value[0].ino !== undefined &&
              stats.value[0].ino === stats.value[1].ino &&
              stats.value[0].dev === stats.value[1].dev
            ) {
              return { _tag: "HardLink" } as LinkState;
            }
          }
          return { _tag: "NotSymlink" } as LinkState;
        }
        return yield* toShadowHomeError(error);
      }),
    ),
  );
});

const removePrivateSymlink = Effect.fn("CodexHomeLayout.removePrivateSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly shadowPath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const privatePath = path.join(input.shadowPath, input.entryName);
  const state = yield* readLinkState(input.fileSystem, privatePath);
  if (state._tag === "Symlink") {
    yield* normalizeShadowHomeError(input.fileSystem.remove(privatePath));
  }
});

const createWindowsSharedLink = Effect.fn("CodexHomeLayout.createWindowsSharedLink")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly shadowPath: string;
    readonly entryName: string;
    readonly target: string;
    readonly link: string;
    readonly forceFileCopy: boolean;
  }) {
    const targetInfo = yield* normalizeShadowHomeError(input.fileSystem.stat(input.target));
    if (targetInfo.type === "Directory") {
      return yield* Effect.try({
        try: () => symlinkSync(input.target, input.link, "junction"),
        catch: toShadowHomeError,
      });
    }

    if (!input.forceFileCopy) {
      const hardLinkResult = yield* input.fileSystem
        .link(input.target, input.link)
        .pipe(Effect.result);
      if (hardLinkResult._tag === "Success") {
        return yield* trackManagedWindowsFile({ ...input, kind: "hardLink" });
      }
      const error = hardLinkResult.failure;
      if (platformErrorCode(error) !== "EXDEV") {
        return yield* toShadowHomeError(error);
      }
    }
    yield* normalizeShadowHomeError(input.fileSystem.copyFile(input.target, input.link));
    yield* trackManagedWindowsFile({ ...input, kind: "copy" });
    yield* Effect.logWarning(
      "Codex shadow-home file crosses Windows volumes; copied file will not stay synchronized",
      { target: input.target, link: input.link },
    );
  },
);

const ensureSymlink = Effect.fn("CodexHomeLayout.ensureSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly shadowPath: string;
  readonly sharedPath: string;
  readonly entryName: string;
  readonly platform: NodeJS.Platform;
  readonly forceWindowsFileCopy: boolean;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const target = path.join(input.sharedPath, input.entryName);
  const link = path.join(input.shadowPath, input.entryName);
  const state = yield* readLinkState(input.fileSystem, link, target, input.platform);

  if (state._tag === "HardLink") {
    return yield* trackManagedWindowsFile({
      ...input,
      target,
      link,
      kind: "hardLink",
    });
  }

  if (state._tag === "NotSymlink") {
    if (
      input.platform === "win32" &&
      (yield* isOwnedManagedWindowsFile({ ...input, target, link }))
    ) {
      yield* normalizeShadowHomeError(input.fileSystem.remove(link));
      return yield* createWindowsSharedLink({
        ...input,
        target,
        link,
        forceFileCopy: input.forceWindowsFileCopy,
      });
    }
    return yield* new CodexShadowHomeError({
      detail: `Cannot create Codex shadow home because '${link}' already exists and is not an F5-managed link or copy.`,
    });
  }

  if (state._tag === "Missing") {
    if (input.platform === "win32") {
      return yield* createWindowsSharedLink({
        ...input,
        target,
        link,
        forceFileCopy: input.forceWindowsFileCopy,
      });
    }
    return yield* normalizeShadowHomeError(input.fileSystem.symlink(target, link));
  }

  const targetInfo =
    input.platform === "win32"
      ? yield* normalizeShadowHomeError(input.fileSystem.stat(target))
      : undefined;
  const mustReplaceWindowsFileSymlink = targetInfo?.type === "File";
  if (
    mustReplaceWindowsFileSymlink ||
    !linksResolveToSameTarget(state.target, target, link, input.platform)
  ) {
    yield* normalizeShadowHomeError(input.fileSystem.remove(link));
    if (input.platform === "win32") {
      yield* createWindowsSharedLink({
        ...input,
        target,
        link,
        forceFileCopy: input.forceWindowsFileCopy,
      });
    } else {
      yield* normalizeShadowHomeError(input.fileSystem.symlink(target, link));
    }
  }
});

const ensureShadowAuthIsPrivate = Effect.fn("CodexHomeLayout.ensureShadowAuthIsPrivate")(function* (
  fileSystem: FileSystem.FileSystem,
  shadowPath: string,
): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const authPath = path.join(shadowPath, "auth.json");
  const state = yield* readLinkState(fileSystem, authPath);
  if (state._tag === "Symlink") {
    return yield* new CodexShadowHomeError({
      detail: `Codex shadow auth file '${authPath}' must be a real file, not a symlink.`,
    });
  }
});

export const materializeCodexShadowHome = Effect.fn("materializeCodexShadowHome")(function* (
  layout: CodexHomeLayout,
  options: MaterializeCodexShadowHomeOptions = {},
) {
  if (layout.mode !== "authOverlay") return;
  const effectiveHomePath = layout.effectiveHomePath;
  if (!effectiveHomePath) return;
  if (layout.sharedHomePath === effectiveHomePath) {
    return yield* new CodexShadowHomeError({
      detail: "Codex shadow home path must be different from the shared home path.",
    });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* normalizeShadowHomeError(
    Effect.all(
      [
        fileSystem.makeDirectory(layout.sharedHomePath, { recursive: true }),
        fileSystem.makeDirectory(effectiveHomePath, { recursive: true }),
        ...KNOWN_SHARED_DIRECTORIES.map((directory) =>
          fileSystem.makeDirectory(path.join(layout.sharedHomePath, directory), {
            recursive: true,
          }),
        ),
      ],
      { concurrency: "unbounded" },
    ),
  );

  const sharedEntryNames = yield* normalizeShadowHomeError(
    fileSystem.readDirectory(layout.sharedHomePath),
  );
  const entries = new Set<string>(KNOWN_SHARED_DIRECTORIES);
  for (const entryName of sharedEntryNames) {
    if (!PRIVATE_ENTRY_NAMES.has(entryName) && !SHADOW_LOCAL_ENTRY_NAMES.has(entryName)) {
      entries.add(entryName);
    }
  }

  yield* Effect.forEach(
    PRIVATE_ENTRY_NAMES,
    (entryName) =>
      entryName === "auth.json"
        ? Effect.void
        : removePrivateSymlink({
            fileSystem,
            shadowPath: effectiveHomePath,
            entryName,
          }),
    { discard: true },
  );

  yield* Effect.forEach(
    entries,
    (entryName) => {
      if (PRIVATE_ENTRY_NAMES.has(entryName)) {
        return Effect.void;
      }
      return ensureSymlink({
        fileSystem,
        shadowPath: effectiveHomePath,
        sharedPath: layout.sharedHomePath,
        entryName,
        platform: options.platform ?? process.platform,
        forceWindowsFileCopy: options.forceWindowsFileCopy ?? false,
      });
    },
    { discard: true },
  );

  yield* ensureShadowAuthIsPrivate(fileSystem, effectiveHomePath);
});

export function codexContinuationIdentity(layout: CodexHomeLayout) {
  return {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: layout.continuationKey,
  };
}
