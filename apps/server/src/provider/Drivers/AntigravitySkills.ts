// @effect-diagnostics nodeBuiltinImport:off - bounded reads need byte-level file handles.
/**
 * Antigravity skill discovery, ported from upstream T3 Code's `AntigravitySkills.ts`
 * (66ca7cdbb1): skill roots, `skills.json` (`inherits`, `entries`, `include_only`, `exclude`)
 * and plugin skills. F5 additionally keeps every configured path under the user's home or the
 * project root, caps inheritance depth and reads only skill frontmatter, within a scan budget.
 *
 * The `.gemini/skills`, `.agents/skills`, `.agent/skills` precedence applies to Antigravity
 * only; the shared project skill ranking does not change.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { ServerProviderSkill } from "@t3tools/contracts";
import { parse as parseYamlDocument } from "yaml";

const MAX_SKILL_BYTES = 1_000_000;
const MAX_SCAN_BYTES = 8_000_000;
const MAX_SCAN_ENTRIES = 10_000;
const MAX_INHERIT_DEPTH = 10;
const SKILL_READ_CHUNK_BYTES = 1024;

interface SkillConfigEntry {
  readonly path: string;
  readonly include_only?: ReadonlyArray<string> | null;
  readonly exclude?: ReadonlyArray<string> | null;
}

interface SkillEntryFilter {
  readonly includeGroups: ReadonlyArray<ReadonlyArray<string>>;
  readonly excludeNames: ReadonlyArray<string>;
}

const EMPTY_FILTER: SkillEntryFilter = { includeGroups: [], excludeNames: [] };

export class AntigravitySkillsScanError extends Error {}

const stringList = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;

function decodeEntries(value: unknown): SkillConfigEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string") return [];
    const include = stringList(entry.include_only);
    const exclude = stringList(entry.exclude);
    return [
      {
        path: entry.path,
        ...(include ? { include_only: include } : {}),
        ...(exclude ? { exclude } : {}),
      },
    ];
  });
}

export function parseAntigravitySkillsConfig(
  raw: string,
): { inherits: SkillConfigEntry[]; entries: SkillConfigEntry[] } | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return undefined;
    const fields = value as Record<string, unknown>;
    return { inherits: decodeEntries(fields.inherits), entries: decodeEntries(fields.entries) };
  } catch {
    return undefined;
  }
}

function matchesFilter(entry: string, filter: SkillEntryFilter): boolean {
  for (const group of filter.includeGroups) if (!group.includes(entry)) return false;
  return !filter.excludeNames.includes(entry);
}

function narrowFilter(parent: SkillEntryFilter, entry: SkillConfigEntry): SkillEntryFilter {
  return {
    includeGroups:
      entry.include_only && entry.include_only.length > 0
        ? [...parent.includeGroups, entry.include_only]
        : parent.includeGroups,
    excludeNames:
      entry.exclude && entry.exclude.length > 0
        ? [...parent.excludeNames, ...entry.exclude]
        : parent.excludeNames,
  };
}

/** The native loader orders child paths with Go's URL.EscapedPath encoding. */
function skillPathSortKey(entry: string) {
  return encodeURI(entry).replace(
    /[!'()*?#]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function parseFrontmatter(contents: string, fileName: string) {
  const start = contents.indexOf("---");
  if (start === -1) return undefined;
  const end = contents.indexOf("---", start + 3);
  if (end === -1) return undefined;
  try {
    const parsed: unknown = parseYamlDocument(contents.slice(start + 3, end).trim()) ?? {};
    const fields = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const name = (typeof fields.name === "string" && fields.name) || fileName.slice(0, -3);
    const description =
      typeof fields.description === "string" ? fields.description.trim() : undefined;
    if (!name || name !== name.trim()) return undefined;
    return { name, ...(description ? { description } : {}) };
  } catch {
    return undefined;
  }
}

const statOrUndefined = (target: string) => NodeFSP.stat(target).catch(() => undefined);

/** agy does not expand `~`, so a `~/` path stays relative to the config file. */
const resolveConfigPath = (rawPath: string, baseDir: string) =>
  NodePath.isAbsolute(rawPath) ? NodePath.resolve(rawPath) : NodePath.resolve(baseDir, rawPath);

const isWithin = (target: string, root: string) => {
  const relative = NodePath.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

export async function discoverAntigravitySkills(input: {
  /** The project root; omitted for instance-level (user) discovery. */
  readonly cwd?: string | undefined;
  readonly userHome: string;
  /** The instance's GEMINI_HOME, where agy loads plugins from. */
  readonly profileDirectory: string;
}): Promise<ServerProviderSkill[]> {
  const budget = { bytes: MAX_SCAN_BYTES, entries: MAX_SCAN_ENTRIES };
  const skills = new Map<string, ServerProviderSkill>();
  const allowedRoots = [
    input.userHome,
    input.profileDirectory,
    ...(input.cwd ? [input.cwd] : []),
  ].map((root) => NodePath.resolve(root));
  // Every path read stays under the home, the profile or the project root after links are
  // followed: configured entries, each traversed directory and each SKILL.md before it opens.
  let realRoots: Promise<string[]> | undefined;
  const allowed = async (target: string) => {
    const real = await NodeFSP.realpath(target).catch(() => undefined);
    if (!real) return false;
    realRoots ??= Promise.all(allowedRoots.map((root) => NodeFSP.realpath(root).catch(() => root)));
    return (await realRoots).some((root) => isWithin(real, root));
  };

  const readFrontmatter = async (skillPath: string) => {
    const limit = Math.min(MAX_SKILL_BYTES, budget.bytes);
    const handle = await NodeFSP.open(skillPath, "r").catch(() => undefined);
    if (!handle) return undefined;
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      let markers = 0;
      let dashes = 0;
      for (;;) {
        const buffer = Buffer.alloc(SKILL_READ_CHUNK_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        let end: number | undefined;
        for (let index = 0; index < chunk.length; index++) {
          dashes = chunk[index] === 0x2d ? dashes + 1 : 0;
          if (dashes === 3) {
            dashes = 0;
            markers++;
            if (markers === 2) {
              end = index + 1;
              break;
            }
          }
        }
        chunks.push(end === undefined ? chunk : chunk.subarray(0, end));
        total += end ?? bytesRead;
        if (total > limit) throw new AntigravitySkillsScanError(`Skill scan limit at ${skillPath}`);
        if (end !== undefined) break;
      }
      budget.bytes -= total;
      return Buffer.concat(chunks).toString("utf8");
    } finally {
      await handle.close();
    }
  };

  const addSkillFile = async (skillPath: string, scope: string) => {
    const fileName = NodePath.basename(skillPath);
    if (fileName.toLowerCase() !== "skill.md" || !fileName.endsWith(".md")) return;
    const info = await statOrUndefined(skillPath);
    if (!info?.isFile() || !(await allowed(skillPath))) return;
    const contents = await readFrontmatter(skillPath);
    if (contents === undefined) return;
    const skill = parseFrontmatter(contents, fileName);
    if (!skill || skills.has(skill.name)) return;
    skills.set(skill.name, { ...skill, path: skillPath, scope, enabled: true });
  };

  const scanDirectory = async (
    directory: string,
    scope: string,
    scanChildren: boolean,
    filter: SkillEntryFilter = EMPTY_FILTER,
    acceptSkillFile = false,
  ): Promise<void> => {
    const info = await statOrUndefined(directory);
    if (!info || !(await allowed(directory))) return;
    if (info.isFile() && acceptSkillFile) {
      if (budget.entries === 0) throw new AntigravitySkillsScanError("Skill scan entry limit");
      budget.entries--;
      if (matchesFilter(NodePath.basename(NodePath.dirname(directory)), filter))
        await addSkillFile(directory, scope);
      return;
    }
    if (!info.isDirectory()) return;
    const entries = await NodeFSP.readdir(directory).catch(() => undefined);
    if (!entries) return;
    if (entries.length > budget.entries)
      throw new AntigravitySkillsScanError("Skill scan entry limit");
    budget.entries -= entries.length;
    const sorted = entries.toSorted();
    const skillFile = sorted.find((entry) => entry.toLowerCase() === "skill.md");
    if (skillFile !== undefined) {
      await addSkillFile(NodePath.join(directory, skillFile), scope);
      return;
    }
    if (!scanChildren) return;
    const children = sorted
      .filter((entry) => matchesFilter(entry, filter))
      .map((entry) => ({ entry, key: skillPathSortKey(entry) }))
      .toSorted((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    for (const { entry } of children)
      await scanDirectory(NodePath.join(directory, entry), scope, false);
  };

  const scanConfig = async (
    configPath: string,
    baseDir: string,
    scope: string,
    filter: SkillEntryFilter,
    visited: ReadonlySet<string>,
    depth: number,
  ): Promise<void> => {
    if (depth > MAX_INHERIT_DEPTH) return;
    const resolved = NodePath.resolve(configPath);
    if (visited.has(resolved) || !(await allowed(resolved))) return;
    const info = await statOrUndefined(resolved);
    if (!info?.isFile()) return;
    if (info.size > Math.min(MAX_SKILL_BYTES, budget.bytes))
      throw new AntigravitySkillsScanError(`Skill scan limit at ${resolved}`);
    const raw = await NodeFSP.readFile(resolved, "utf8").catch(() => undefined);
    if (raw === undefined) return;
    budget.bytes -= Buffer.byteLength(raw, "utf8");
    const parsed = parseAntigravitySkillsConfig(raw);
    if (!parsed) return;
    const nextVisited = new Set(visited).add(resolved);
    for (const inherited of parsed.inherits) {
      const inheritedPath = resolveConfigPath(inherited.path, baseDir);
      await scanConfig(
        inheritedPath,
        NodePath.dirname(inheritedPath),
        scope,
        narrowFilter(filter, inherited),
        nextVisited,
        depth + 1,
      );
    }
    for (const entry of parsed.entries) {
      const directory = resolveConfigPath(entry.path, baseDir);
      if (!(await allowed(directory))) continue;
      await scanDirectory(directory, scope, true, narrowFilter(filter, entry), true);
    }
  };

  const gemini = NodePath.join(input.userHome, ".gemini");
  const roots: Array<{ directory: string; scope: string }> = [
    { directory: NodePath.join(gemini, "config", "skills"), scope: "user" },
    ...(input.cwd
      ? [{ directory: NodePath.resolve(input.cwd, ".gemini", "skills"), scope: "project" }]
      : []),
    { directory: NodePath.join(gemini, "antigravity-cli", "skills"), scope: "user" },
    ...(input.cwd
      ? [
          { directory: NodePath.resolve(input.cwd, ".agents", "skills"), scope: "project" },
          { directory: NodePath.resolve(input.cwd, ".agent", "skills"), scope: "project" },
        ]
      : []),
  ];
  for (const root of roots) await scanDirectory(root.directory, root.scope, true);

  const configs = [
    ...(input.cwd
      ? [
          {
            configPath: NodePath.resolve(input.cwd, ".agents", "skills.json"),
            baseDir: input.cwd,
            scope: "project",
          },
          {
            configPath: NodePath.resolve(input.cwd, ".agent", "skills.json"),
            baseDir: input.cwd,
            scope: "project",
          },
        ]
      : []),
    {
      configPath: NodePath.join(gemini, "config", "skills.json"),
      baseDir: NodePath.join(gemini, "config"),
      scope: "user",
    },
  ];
  for (const config of configs)
    await scanConfig(config.configPath, config.baseDir, config.scope, EMPTY_FILTER, new Set(), 0);

  const pluginsDirectory = NodePath.join(input.profileDirectory, "config", "plugins");
  const plugins = await NodeFSP.readdir(pluginsDirectory).catch(() => undefined);
  if (plugins && plugins.length > 0) {
    const configPath = NodePath.join(input.profileDirectory, "config", "config.json");
    const configInfo = await statOrUndefined(configPath);
    let disabled = new Set<string>();
    if (configInfo?.isFile() && configInfo.size <= MAX_SKILL_BYTES) {
      try {
        const preferences: unknown = JSON.parse(await NodeFSP.readFile(configPath, "utf8"));
        const entries =
          preferences && typeof preferences === "object"
            ? (preferences as { plugins?: unknown }).plugins
            : undefined;
        if (entries && typeof entries === "object")
          disabled = new Set(
            Object.entries(entries as Record<string, unknown>).flatMap(([name, plugin]) =>
              plugin &&
              typeof plugin === "object" &&
              (plugin as { enabled?: unknown }).enabled === false
                ? [name]
                : [],
            ),
          );
      } catch {
        /* Unreadable preferences enable every plugin, as the CLI does. */
      }
    }
    for (const plugin of plugins.toSorted()) {
      if (disabled.has(plugin)) continue;
      const directory = NodePath.join(pluginsDirectory, plugin);
      if (!(await statOrUndefined(directory))?.isDirectory()) continue;
      await scanDirectory(NodePath.join(directory, "skills"), "user", true);
    }
  }
  return [...skills.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}
