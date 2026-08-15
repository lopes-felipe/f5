import type { ThreadEnvMode } from "@t3tools/contracts";

export function resolveThreadEnvMode(input: {
  readonly requested?: ThreadEnvMode | null | undefined;
  readonly projectDefault?: ThreadEnvMode | null | undefined;
  readonly globalDefault: ThreadEnvMode;
}): ThreadEnvMode {
  return input.requested ?? input.projectDefault ?? input.globalDefault;
}

export function nonDefaultThreadEnvMode(defaultMode: ThreadEnvMode): ThreadEnvMode {
  return defaultMode === "local" ? "worktree" : "local";
}
