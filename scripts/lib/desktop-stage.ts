import { resolveCatalogDependencies } from "./resolve-catalog.ts";

export type DesktopStagePlatform = "mac" | "linux" | "win";
export type DesktopStageArch = "arm64" | "x64" | "universal";

function resolveDesktopRuntimeDependencies(
  platform: DesktopStagePlatform,
  dependencies: Record<string, unknown> | undefined,
  catalog: Record<string, unknown>,
): Record<string, unknown> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  const runtimeDependencies = Object.fromEntries(
    Object.entries(dependencies).filter(
      ([dependencyName]) =>
        dependencyName !== "electron" &&
        // The settings portal transport includes a Unix-only native addon.
        (dependencyName !== "dbus-next" || platform === "linux"),
    ),
  );

  return resolveCatalogDependencies(runtimeDependencies, catalog, "apps/desktop");
}

function resolveFffBinaryDependencies(
  platform: DesktopStagePlatform,
  arch: DesktopStageArch,
  version: unknown,
): Record<string, unknown> {
  if (typeof version !== "string" || version.length === 0) {
    return {};
  }

  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : ([arch] as const);
  if (platform === "mac") {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-darwin-${architecture}`, version]),
    );
  }

  if (platform === "win") {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-win32-${architecture}`, version]),
    );
  }

  return Object.fromEntries(
    architectures.flatMap((architecture) =>
      (["gnu", "musl"] as const).map((libc) => [
        `@ff-labs/fff-bin-linux-${architecture}-${libc}`,
        version,
      ]),
    ),
  );
}

/** Production dependencies of the staged desktop app: server, platform fff binaries, desktop runtime. */
export function stagedDesktopDependencies(input: {
  readonly platform: DesktopStagePlatform;
  readonly arch: DesktopStageArch;
  readonly serverDependencies: Record<string, unknown>;
  readonly desktopDependencies: Record<string, unknown> | undefined;
  readonly catalog: Record<string, unknown>;
}): Record<string, unknown> {
  if (Object.keys(input.serverDependencies).length === 0)
    throw new Error("apps/server/package.json has no production dependencies.");
  return {
    ...resolveCatalogDependencies(input.serverDependencies, input.catalog, "apps/server"),
    ...resolveFffBinaryDependencies(
      input.platform,
      input.arch,
      input.serverDependencies["@ff-labs/fff-node"],
    ),
    ...resolveDesktopRuntimeDependencies(input.platform, input.desktopDependencies, input.catalog),
  };
}
