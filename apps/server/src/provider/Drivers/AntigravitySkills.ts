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

/** A frontmatter delimiter is a line of exactly `---` (trailing spaces and `\r` allowed). */
const isDelimiterLine = (line: string) => /^---[ \t]*\r?$/.test(line);
/** `SKILL.md` in any case for the stem, with a lowercase `.md` extension. */
const isSkillFileName = (name: string) => name.toLowerCase() === "skill.md" && name.endsWith(".md");

function parseFrontmatter(contents: string, fileName: string) {
  const lines = contents.split("\n");
  const start = lines.findIndex(isDelimiterLine);
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && isDelimiterLine(line));
  if (end === -1) return undefined;
  try {
    const parsed: unknown =
      parseYamlDocument(
        lines
          .slice(start + 1, end)
          .join("\n")
          .trim(),
      ) ?? {};
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

/** Rejects a leading parent segment or an absolute result; `..local` is a valid child. */
const isWithin = (target: string, root: string) => {
  const relative = NodePath.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
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

  /**
   * Opens a regular file and binds the containment check to it: the opened file must be the
   * file its link-resolved path names, and that path must be under an allowed root. A path
   * swapped between the check and the open therefore cannot substitute another file.
   */
  const openContained = async (target: string) => {
    const handle = await NodeFSP.open(target, "r").catch(() => undefined);
    if (!handle) return undefined;
    try {
      const opened = await handle.stat();
      const real = await NodeFSP.realpath(target).catch(() => undefined);
      const named = real ? await statOrUndefined(real) : undefined;
      if (
        opened.isFile() &&
        named !== undefined &&
        named.ino === opened.ino &&
        named.dev === opened.dev &&
        (await allowed(real!))
      )
        return handle;
    } catch {
      /* fall through: refuse */
    }
    await handle.close();
    return undefined;
  };

  /** Reads up to `limit` bytes; `undefined` when the file is larger (skipped, not fatal). */
  const readBounded = async (target: string, limit: number) => {
    const handle = await openContained(target);
    if (!handle) return undefined;
    try {
      const buffer = Buffer.alloc(limit + 1);
      let total = 0;
      while (total <= limit) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      budget.bytes -= Math.min(total, limit);
      return total > limit ? undefined : buffer.subarray(0, total).toString("utf8");
    } finally {
      await handle.close();
    }
  };

  /**
   * Reads the file up to the end of its frontmatter (the second delimiter line). A file over the
   * per-file or remaining scan budget, or one that cannot be opened safely, is skipped.
   */
  const readFrontmatter = async (skillPath: string) => {
    const limit = Math.min(MAX_SKILL_BYTES, budget.bytes);
    if (limit <= 0) return undefined;
    const handle = await openContained(skillPath);
    if (!handle) return undefined;
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      let delimiters = 0;
      // A streaming match of `isDelimiterLine` (`---`, then spaces or tabs, then an optional CR)
      // that keeps no line text, so any amount of trailing padding is recognised.
      let dashes = 0;
      let delimiterSoFar = true;
      let sawCarriageReturn = false;
      for (;;) {
        const buffer = Buffer.alloc(SKILL_READ_CHUNK_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        let end: number | undefined;
        for (let index = 0; index < chunk.length; index++) {
          const byte = chunk[index]!;
          if (byte !== 0x0a) {
            if (!delimiterSoFar) continue;
            if (sawCarriageReturn) delimiterSoFar = false;
            else if (dashes < 3) {
              if (byte === 0x2d) dashes++;
              else delimiterSoFar = false;
            } else if (byte === 0x0d) sawCarriageReturn = true;
            else if (byte !== 0x20 && byte !== 0x09) delimiterSoFar = false;
            continue;
          }
          if (delimiterSoFar && dashes === 3) delimiters++;
          dashes = 0;
          delimiterSoFar = true;
          sawCarriageReturn = false;
          if (delimiters === 2) {
            end = index + 1;
            break;
          }
        }
        chunks.push(end === undefined ? chunk : chunk.subarray(0, end));
        total += end ?? bytesRead;
        if (total > limit) {
          budget.bytes -= limit;
          return undefined;
        }
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
    if (!isSkillFileName(fileName)) return;
    const info = await statOrUndefined(skillPath);
    if (!info?.isFile()) return;
    const contents = await readFrontmatter(skillPath);
    if (contents === undefined) return;
    const skill = parseFrontmatter(contents, fileName);
    if (!skill || skills.has(skill.name)) return;
    skills.set(skill.name, { ...skill, path: skillPath, scope, enabled: true });
  };

  /**
   * Lists at most the remaining entry budget, reading the directory incrementally, so a huge
   * directory never loads in full. Every listing (skill roots and plugins) is charged.
   */
  const listDirectory = async (directory: string): Promise<string[] | undefined> => {
    const dir = await NodeFSP.opendir(directory).catch(() => undefined);
    if (!dir) return undefined;
    const names: string[] = [];
    try {
      for await (const entry of dir) {
        if (budget.entries === 0) break;
        budget.entries--;
        names.push(entry.name);
      }
    } catch {
      return names;
    }
    return names;
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
      if (budget.entries === 0) return;
      budget.entries--;
      if (matchesFilter(NodePath.basename(NodePath.dirname(directory)), filter))
        await addSkillFile(directory, scope);
      return;
    }
    if (!info.isDirectory()) return;
    const entries = await listDirectory(directory);
    if (!entries) return;
    const sorted = entries.toSorted();
    // The same rule as reading, with the canonical name first: on a case-sensitive filesystem
    // an ineligible `SKILL.MD` must not hide `SKILL.md`.
    const skillFile = sorted.find((entry) => entry === "SKILL.md") ?? sorted.find(isSkillFileName);
    if (skillFile !== undefined) {
      // A configured directory that is itself a skill is filtered by its own name, like an
      // entry that names its SKILL.md directly.
      if (matchesFilter(NodePath.basename(directory), filter))
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
    // Bounded by the read itself, not the earlier stat: a file that grew is skipped.
    const raw = await readBounded(resolved, Math.min(MAX_SKILL_BYTES, budget.bytes));
    if (raw === undefined) return;
    const parsed = parseAntigravitySkillsConfig(raw);
    if (!parsed) return;
    const nextVisited = new Set(visited).add(resolved);
    // Each configured path costs one entry before any filesystem call, so a small file listing
    // thousands of paths can't do unbounded work; siblings stop once the budget is spent.
    const charge = () => {
      if (budget.entries === 0) return false;
      budget.entries--;
      return true;
    };
    for (const inherited of parsed.inherits) {
      if (!charge()) return;
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
      if (!charge()) return;
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
  const plugins = (await allowed(pluginsDirectory))
    ? await listDirectory(pluginsDirectory)
    : undefined;
  if (plugins && plugins.length > 0) {
    const configPath = NodePath.join(input.profileDirectory, "config", "config.json");
    const configText = await readBounded(configPath, Math.min(MAX_SKILL_BYTES, budget.bytes));
    let disabled = new Set<string>();
    if (configText !== undefined) {
      try {
        const preferences: unknown = JSON.parse(configText);
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
