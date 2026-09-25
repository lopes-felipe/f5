import * as path from "node:path";
import { Effect, FileSystem } from "effect";
import type { ServerProviderSkill } from "@t3tools/contracts";
import { parseClaudeSkillDocument } from "../../orchestration/projectSkills.ts";
import { normalizeSupportedSlashCommands } from "../supportedSlashCommands.ts";

/** Follow linked packages, but never recursively scan a library outside the skill root. */
export const discoverCursorSkills = Effect.fn("discoverCursorSkills")(function* (
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const home = environment.HOME?.trim() || environment.USERPROFILE?.trim();
  const roots = [
    { directory: path.join(cwd, ".cursor", "skills"), scope: "project" },
    ...(home ? [{ directory: path.join(home, ".cursor", "skills"), scope: "user" }] : []),
  ];
  const skills = new Map<string, ServerProviderSkill>();
  let entriesLeft = 10_000;
  let bytesLeft = 8_000_000;
  for (const root of roots) {
    const canonicalRoot = yield* fs
      .realPath(root.directory)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (!canonicalRoot) continue;
    const visited = new Set<string>();
    const pending = [{ directory: root.directory, depth: 0 }];
    while (pending.length && entriesLeft > 0 && bytesLeft > 0) {
      const current = pending.shift()!;
      entriesLeft--;
      const canonical = yield* fs
        .realPath(current.directory)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (!canonical || visited.has(canonical)) continue;
      visited.add(canonical);
      const skillPath = path.join(current.directory, "SKILL.md");
      const stat = yield* fs.stat(skillPath).pipe(Effect.orElseSucceed(() => undefined));
      if (stat?.type === "File" && Number(stat.size) <= Math.min(1_000_000, bytesLeft)) {
        bytesLeft -= Number(stat.size);
        const documentText = yield* fs
          .readFileString(skillPath)
          .pipe(Effect.orElseSucceed(() => undefined));
        const name = path.basename(current.directory);
        if (documentText && !skills.has(name)) {
          const parsed = yield* Effect.try({
            try: () => parseClaudeSkillDocument({ commandName: name, documentText }),
            catch: () => "invalid-skill" as const,
          }).pipe(Effect.orElseSucceed(() => undefined));
          if (parsed)
            skills.set(name, {
              name,
              path: skillPath,
              scope: root.scope,
              enabled: true,
              description: parsed.description,
              ...(parsed.displayName ? { displayName: parsed.displayName } : {}),
            });
        }
      }
      if (stat?.type === "File") continue;
      if (
        current.depth >= 10 ||
        (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${path.sep}`))
      )
        continue;
      const children = yield* fs
        .readDirectory(current.directory)
        .pipe(Effect.orElseSucceed(() => []));
      for (const child of children.toSorted()) {
        if (pending.length >= entriesLeft) break;
        const directory = path.join(current.directory, child);
        const info = yield* fs.stat(directory).pipe(Effect.orElseSucceed(() => undefined));
        if (info?.type === "Directory") pending.push({ directory, depth: current.depth + 1 });
        else entriesLeft--;
      }
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
});

export const cursorSkillCommands = (skills: ReadonlyArray<ServerProviderSkill>) =>
  normalizeSupportedSlashCommands(
    skills.map((skill) => ({
      name: skill.name,
      description: skill.description ?? `Use ${skill.name}`,
    })),
  );
