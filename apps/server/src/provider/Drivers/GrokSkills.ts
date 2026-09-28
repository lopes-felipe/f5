import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GrokSettings, ServerProviderSkill } from "@t3tools/contracts";
import { Effect } from "effect";
import { runProcess } from "../../processRunner.ts";

/** Ask the CLI so disabled and plugin skills follow Grok's own configuration. */
export function parseGrokSkills(text: string): ServerProviderSkill[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!value || typeof value !== "object" || !("skills" in value) || !Array.isArray(value.skills))
    return [];
  const skills = new Map<string, ServerProviderSkill>();
  for (const item of value.skills) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.name !== "string" ||
      typeof item.source?.path !== "string"
    )
      continue;
    const name = item.name.trim();
    const path = item.source.path.trim();
    if (!name || !path) continue;
    const skill: ServerProviderSkill = {
      name,
      path,
      enabled: item.userInvocable !== false,
      ...(typeof item.description === "string" && item.description.trim()
        ? { description: item.description.trim() }
        : {}),
      ...(typeof item.source.type === "string" && item.source.type.trim()
        ? { scope: item.source.type.trim() }
        : {}),
    };
    if (!skills.has(name) || skill.scope === "project") skills.set(name, skill);
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const discoverGrokSkills = (
  settings: Pick<GrokSettings, "binaryPath">,
  env: NodeJS.ProcessEnv,
  cwd: string,
) =>
  Effect.tryPromise({
    try: (signal) =>
      runProcess(settings.binaryPath || "grok", ["inspect", "--json"], {
        env,
        cwd,
        signal,
        timeoutMs: 4000,
        maxBufferBytes: 1024 * 1024,
        outputMode: "error",
      }),
    catch: () => ({ _tag: "GrokSkillsUnavailable" as const }),
  }).pipe(
    Effect.map((result) => parseGrokSkills(result.stdout)),
    Effect.orElseSucceed(() => []),
  );

/** Inventory for the global provider picker must not inherit the server's project. */
export const discoverGlobalGrokSkills = (
  settings: Pick<GrokSettings, "binaryPath">,
  env: NodeJS.ProcessEnv,
) =>
  Effect.acquireUseRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "f5-grok-skills-"))),
    (cwd) =>
      discoverGrokSkills(settings, env, cwd).pipe(
        Effect.map((skills) => skills.filter((skill) => skill.scope !== "project")),
      ),
    (cwd) => Effect.promise(() => rm(cwd, { recursive: true, force: true })),
  ).pipe(Effect.orElseSucceed(() => []));
