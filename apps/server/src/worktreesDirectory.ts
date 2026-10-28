import { Effect, Option } from "effect";
import { ServerSettingsService } from "./serverSettings.ts";
import {
  canonicalManagedWorktreesDirectories,
  DEFAULT_WORKTREES_SETTINGS,
} from "./worktreesDirectoryPaths.ts";
export {
  allocationWorktreesDirectory,
  customWorktreesDirectory,
  canonicalManagedWorktreesDirectories,
  DEFAULT_WORKTREES_SETTINGS,
  isFilesystemRoot,
  managedWorktreesDirectories,
  resolveWorktreesDirectory,
  validManagedWorktreesDirectories,
} from "./worktreesDirectoryPaths.ts";

/** Capture the settings service when constructing a layer, then read its live values per operation. */
export const makeWorktreesSettingsReader = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(ServerSettingsService);
  return Option.isSome(service)
    ? service.value.getSettings.pipe(Effect.orElseSucceed(() => DEFAULT_WORKTREES_SETTINGS))
    : Effect.succeed(DEFAULT_WORKTREES_SETTINGS);
});

export const readManagedWorktreesDirectories = (defaultDir: string) =>
  makeWorktreesSettingsReader.pipe(
    Effect.flatten,
    Effect.flatMap((settings) => canonicalManagedWorktreesDirectories(settings, defaultDir)),
  );
