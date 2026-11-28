import type { ProjectId, ServerSettings, ThreadEnvMode } from "@t3tools/contracts";
import { Effect } from "effect";

import { readProjectSettings } from "./projectSettings.ts";

/** The effective Branch prefix for a project, or the global one. Never fails. */
export const readBranchNamePrefix = <E>(
  getSettings: Effect.Effect<ServerSettings, E>,
  project: {
    id: ProjectId;
    workspaceRoot: string;
    defaultEnvMode?: ThreadEnvMode | null | undefined;
  } | null,
) =>
  Effect.gen(function* () {
    const global = yield* getSettings;
    const settings = project ? (yield* readProjectSettings(global, project)).settings : global;
    return settings.sourceControlWriting.branchNamePrefix;
  }).pipe(Effect.orElseSucceed(() => ""));
