import * as NodePath from "node:path";
import { stripContextHandoffBlocks } from "@t3tools/shared/conversationHandoff";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { Effect, type FileSystem, Schema } from "effect";
import { readClaudeSkillInvocationFlags } from "../orchestration/projectSkills.ts";
import {
  claudeManagedSettingsDir,
  readClaudeInventory,
  resolveClaudeUserStatePath,
} from "./claudeInventory.ts";
import { resolveClaudeConfigDir } from "./Drivers/ClaudeHome.ts";

const SKILL_MENTION = /(^|\s)\/([a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)?)(?=\s|$)/g;
const MAX_SKILL_FILE_BYTES = 1024 * 1024;

const SkillOverride = Schema.Literals(["on", "name-only", "user-invocable-only", "off"]);
const decodeSkillOverrides = Schema.decodeUnknownEffect(
  fromLenientJson(
    Schema.Struct({ skillOverrides: Schema.optional(Schema.Record(Schema.String, SkillOverride)) }),
  ),
);

function isWithinDirectory(directory: string, candidate: string): boolean {
  const relative = NodePath.relative(directory, candidate);
  return (
    relative !== ".." && !relative.startsWith(".." + NodePath.sep) && !NodePath.isAbsolute(relative)
  );
}

const readSkillFile = (fileSystem: FileSystem.FileSystem, path: string) =>
  Effect.gen(function* () {
    const info = yield* fileSystem.stat(path);
    if (info.type !== "File" || info.size > MAX_SKILL_FILE_BYTES) return undefined;
    return yield* fileSystem.readFileString(path);
  }).pipe(Effect.orElseSucceed(() => undefined));

function pluginSkillDirectories(fileSystem: FileSystem.FileSystem, installPath: string) {
  return readSkillFile(
    fileSystem,
    NodePath.join(installPath, ".claude-plugin", "plugin.json"),
  ).pipe(
    Effect.map((document) => {
      if (!document) return [];
      try {
        const manifest: unknown = JSON.parse(document);
        if (!manifest || typeof manifest !== "object" || !("skills" in manifest)) return [];
        const paths: unknown[] = Array.isArray(manifest.skills)
          ? manifest.skills
          : [manifest.skills];
        return paths.flatMap((path) => {
          if (typeof path !== "string") return [];
          const directory = NodePath.resolve(installPath, path);
          return isWithinDirectory(installPath, directory) ? [directory] : [];
        });
      } catch {
        return [];
      }
    }),
  );
}

export function planClaudeSkillDispatch(input: {
  readonly text: string;
  readonly cwd: string | undefined;
  readonly additionalDirectories: ReadonlyArray<string> | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly fileSystem: FileSystem.FileSystem;
  readonly nativeCommands: ReadonlySet<string> | undefined;
}) {
  return Effect.gen(function* () {
    const userText = stripContextHandoffBlocks(input.text);
    const handoffLength = input.text.length - userText.length;
    const mentions = [...userText.matchAll(SKILL_MENTION)].map((match) => ({
      name: match[2]!,
      start: handoffLength + match.index + match[1]!.length,
      end: handoffLength + match.index + match[0].length,
    }));
    if (mentions.length < 2) return undefined;

    const cwd = input.cwd ?? process.cwd();
    const configDir = resolveClaudeConfigDir(input.environment, cwd);
    const skillRoots = [
      NodePath.join(configDir, "skills"),
      ...[...new Set([cwd, ...(input.additionalDirectories ?? [])])].map((directory) =>
        NodePath.join(directory, ".claude", "skills"),
      ),
    ];
    const knownMentions = mentions.filter(
      (mention) => input.nativeCommands?.has(mention.name) ?? true,
    );
    if (knownMentions.length < 2) return undefined;
    const names = new Set(knownMentions.map((mention) => mention.name));
    const managedSettingsPath =
      input.environment.CLAUDE_CODE_MANAGED_SETTINGS_PATH ??
      NodePath.join(claudeManagedSettingsDir(process.platform), "managed-settings.json");
    const overrides = Object.assign(
      Object.create(null) as Record<string, typeof SkillOverride.Type>,
      ...(yield* Effect.forEach(
        [
          NodePath.join(configDir, "settings.json"),
          NodePath.join(cwd, ".claude", "settings.json"),
          NodePath.join(cwd, ".claude", "settings.local.json"),
          managedSettingsPath,
        ],
        (path) =>
          readSkillFile(input.fileSystem, path).pipe(
            Effect.flatMap(decodeSkillOverrides),
            Effect.map((settings) => settings.skillOverrides),
            Effect.orElseSucceed(() => undefined),
          ),
        { concurrency: 4 },
      )),
    );
    const pluginRoots = new Map<string, string[]>();
    const mentionedPlugins = new Set(
      [...names].flatMap((name) => (name.includes(":") ? [name.split(":")[0]!] : [])),
    );
    if (mentionedPlugins.size > 0 && input.nativeCommands) {
      const inventory = yield* Effect.tryPromise(() =>
        readClaudeInventory({
          configDir,
          userStatePath: resolveClaudeUserStatePath(input.environment, configDir),
          projectRoot: cwd,
          managedSettingsPath,
        }),
      ).pipe(Effect.orElseSucceed(() => undefined));
      const pluginsDir = NodePath.join(configDir, "plugins");
      for (const plugin of inventory?.plugins ?? []) {
        if (
          plugin.enabled === false ||
          !plugin.sourcePath ||
          !mentionedPlugins.has(plugin.name) ||
          !isWithinDirectory(pluginsDir, plugin.sourcePath)
        ) {
          continue;
        }
        const roots = pluginRoots.get(plugin.name) ?? [];
        roots.push(
          NodePath.join(plugin.sourcePath, "skills"),
          ...(yield* pluginSkillDirectories(input.fileSystem, plugin.sourcePath)),
        );
        pluginRoots.set(plugin.name, roots);
      }
    }

    const skills = new Map<string, { path: string; userInvocationOnly: boolean }>();
    yield* Effect.forEach(
      names,
      (name) =>
        Effect.gen(function* () {
          if (overrides[name] === "off") return;
          const [prefix, pluginSkill] = name.split(":");
          const roots = pluginSkill ? (pluginRoots.get(prefix!) ?? []) : skillRoots;
          for (const root of roots) {
            const path = NodePath.join(
              root,
              pluginSkill && NodePath.basename(root) === pluginSkill ? "" : (pluginSkill ?? name),
              "SKILL.md",
            );
            const text = yield* readSkillFile(input.fileSystem, path);
            if (typeof text !== "string") continue;
            const flags = readClaudeSkillInvocationFlags(text);
            if (flags?.userInvocable)
              skills.set(name, {
                path,
                userInvocationOnly:
                  flags.userInvocationOnly || overrides[name] === "user-invocable-only",
              });
            break;
          }
        }),
      { concurrency: 4, discard: true },
    );

    // Preserve other leading native commands such as /compact, even when their
    // arguments mention skills.
    if (input.text.startsWith("/") && !(mentions[0]?.start === 0 && skills.has(mentions[0].name))) {
      return undefined;
    }
    const invoked = knownMentions.filter((mention) => skills.has(mention.name));
    if (invoked.length < 2) return undefined;
    const last = invoked.at(-1)!;
    const annotated = new Set([last.name]);
    let leadingText = "";
    let cursor = 0;
    for (const mention of invoked) {
      leadingText += input.text.slice(cursor, mention.end);
      cursor = mention.end;
      const skill = skills.get(mention.name)!;
      if (skill.userInvocationOnly && !annotated.has(mention.name)) {
        leadingText += ` [The user invoked this skill. Follow the instructions in ${JSON.stringify(skill.path)}.]`;
        annotated.add(mention.name);
      }
    }
    return {
      leadingText: leadingText + input.text.slice(cursor),
      commandText: input.text.slice(last.start).trimEnd(),
    };
  });
}
