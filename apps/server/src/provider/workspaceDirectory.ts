import { stat } from "node:fs/promises";
import { Effect } from "effect";
import { ProviderValidationError } from "./Errors.ts";

export const ensureWorkspaceDirectory = (cwd: string) =>
  Effect.gen(function* () {
    const entry = yield* Effect.tryPromise({
      try: () => stat(cwd),
      catch: (cause) =>
        new ProviderValidationError({
          operation: "workspace",
          issue:
            (cause as NodeJS.ErrnoException).code === "ENOENT"
              ? `Workspace folder is missing: ${cwd}`
              : `Cannot access workspace folder: ${cwd}`,
        }),
    });
    if (!entry.isDirectory())
      return yield* new ProviderValidationError({
        operation: "workspace",
        issue: `Workspace folder is missing: ${cwd}`,
      });
  });
