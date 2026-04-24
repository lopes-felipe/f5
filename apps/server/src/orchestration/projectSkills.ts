import { type ProjectId, type ProjectSkill, type ProjectSkillScope } from "@t3tools/contracts";
import { Data, Effect, FileSystem, Path } from "effect";
import { parseDocument } from "yaml";

export const RESERVED_PROJECT_SKILL_COMMAND_NAMES = ["model", "plan", "default"] as const;

type ReservedProjectSkillCommandName = (typeof RESERVED_PROJECT_SKILL_COMMAND_NAMES)[number];

export interface ProjectSkillScanWarning {
  readonly scope: ProjectSkillScope;
  readonly commandName: string;
  readonly path: string;
  readonly reason: string;
}

interface ParsedClaudeSkillDocument {
  readonly displayName: string | null;
  readonly description: string;
  readonly argumentHint: string | null;
  readonly allowedTools: ReadonlyArray<string>;
  readonly paths: ReadonlyArray<string>;
}

interface ProjectSkillCandidate extends ProjectSkill {
  readonly canonicalPath: string;
}

interface ScopeScanResult {
  readonly candidates: ReadonlyArray<ProjectSkillCandidate>;
  readonly watchPaths: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<ProjectSkillScanWarning>;
}

export interface ProjectSkillScanResult {
  readonly skills: ReadonlyArray<ProjectSkill>;
  readonly watchPaths: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<ProjectSkillScanWarning>;
}

class ProjectSkillParseError extends Data.TaggedError("ProjectSkillParseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function splitFrontmatter(documentText: string): {
  readonly frontmatterText: string | null;
  readonly bodyText: string;
} {
  const normalized = documentText.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) {
    return {
      frontmatterText: null,
      bodyText: normalized,
    };
  }

  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized);
  if (!match) {
    return {
      frontmatterText: null,
      bodyText: normalized,
    };
  }

  return {
    frontmatterText: match[1] ?? null,
    bodyText: normalized.slice(match[0].length),
  };
}

function normalizeStringList(value: unknown): ReadonlyArray<string> {
  if (typeof value === "string") {
    return value
      .split(/[\s,]+/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .flatMap((entry) => {
      const normalized = asTrimmedString(entry);
      return normalized ? [normalized] : [];
    })
    .filter((entry, index, array) => array.indexOf(entry) === index);
}

function extractFallbackDescription(bodyText: string): string | null {
  const paragraphs = bodyText
    .split(/\r?\n\s*\r?\n/g)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  for (const paragraph of paragraphs) {
    if (paragraph.startsWith("#")) {
      continue;
    }
    return paragraph.replace(/\s+/g, " ").trim();
  }

  return null;
}

function parseYamlFrontmatter(frontmatterText: string): Record<string, unknown> {
  const document = parseDocument(frontmatterText);
  if (document.errors.length > 0) {
    throw new Error(
      document.errors.map((error: { readonly message: string }) => error.message).join("; "),
    );
  }

  const parsed = document.toJS();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function readYamlValue<T extends string>(
  record: Record<string, unknown>,
  key: T,
  aliases: ReadonlyArray<string> = [],
): unknown {
  if (key in record) {
    return record[key];
  }
  for (const alias of aliases) {
    if (alias in record) {
      return record[alias];
    }
  }
  return undefined;
}

export function isReservedProjectSkillCommandName(
  value: string,
): value is ReservedProjectSkillCommandName {
  return RESERVED_PROJECT_SKILL_COMMAND_NAMES.includes(
    value.toLowerCase() as ReservedProjectSkillCommandName,
  );
}

export function isSafeProjectSkillDirectoryName(value: string): boolean {
  if (value.includes("\0") || value.includes("/") || value.includes("\\")) {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== "." && trimmed !== "..";
}

export function parseClaudeSkillDocument(input: {
  readonly commandName: string;
  readonly documentText: string;
}): ParsedClaudeSkillDocument {
  const { frontmatterText, bodyText } = splitFrontmatter(input.documentText);
  const frontmatter = frontmatterText ? parseYamlFrontmatter(frontmatterText) : {};

  const displayName = asTrimmedString(readYamlValue(frontmatter, "name"));
  const description =
    asTrimmedString(readYamlValue(frontmatter, "description")) ??
    extractFallbackDescription(bodyText);
  if (!description) {
    throw new Error(
      `Skill '${input.commandName}' must define a description in YAML frontmatter or markdown body.`,
    );
  }

  return {
    displayName,
    description,
    argumentHint: asTrimmedString(readYamlValue(frontmatter, "argument-hint", ["argumentHint"])),
    allowedTools: normalizeStringList(
      readYamlValue(frontmatter, "allowed-tools", ["allowedTools"]),
    ),
    paths: normalizeStringList(readYamlValue(frontmatter, "paths")),
  };
}

function skillIdForProject(input: {
  readonly projectId: ProjectId;
  readonly commandName: string;
}): string {
  return `${input.projectId}:skill:${input.commandName}`;
}

function fingerprintComparableSkill(skill: ProjectSkill) {
  return {
    projectId: skill.projectId,
    scope: skill.scope,
    commandName: skill.commandName,
    displayName: skill.displayName,
    description: skill.description,
    argumentHint: skill.argumentHint,
    allowedTools: [...skill.allowedTools],
    paths: [...skill.paths],
  };
}

export function buildProjectSkillFingerprint(skills: ReadonlyArray<ProjectSkill>): string {
  return JSON.stringify(
    skills
      .map(fingerprintComparableSkill)
      .toSorted((left, right) => left.commandName.localeCompare(right.commandName)),
  );
}

function uniqueSortedPaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(paths)].toSorted((left, right) => left.localeCompare(right));
}

const scanSkillScope = Effect.fn(function* (input: {
  readonly projectId: ProjectId;
  readonly scope: ProjectSkillScope;
  readonly workspaceParentPath: string;
  readonly claudeDirPath: string;
  readonly skillsDirPath: string;
}): Effect.fn.Return<ScopeScanResult, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedSkillsDirPath = path.resolve(input.skillsDirPath);

  const watchPaths = new Set<string>();
  const warnings: Array<ProjectSkillScanWarning> = [];
  const candidates: Array<ProjectSkillCandidate> = [];

  const claudeDirInfo = yield* fs
    .stat(input.claudeDirPath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!claudeDirInfo || claudeDirInfo.type !== "Directory") {
    watchPaths.add(input.workspaceParentPath);
    return {
      candidates,
      watchPaths: uniqueSortedPaths([...watchPaths]),
      warnings,
    };
  }

  watchPaths.add(input.claudeDirPath);

  const skillsDirInfo = yield* fs
    .stat(input.skillsDirPath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!skillsDirInfo || skillsDirInfo.type !== "Directory") {
    return {
      candidates,
      watchPaths: uniqueSortedPaths([...watchPaths]),
      warnings,
    };
  }

  watchPaths.add(input.skillsDirPath);

  const skillDirectoryNames = yield* fs
    .readDirectory(input.skillsDirPath, { recursive: false })
    .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));

  for (const directoryName of skillDirectoryNames.toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    const commandName = directoryName.trim();
    if (commandName.length === 0) {
      continue;
    }
    if (!isSafeProjectSkillDirectoryName(directoryName)) {
      warnings.push({
        scope: input.scope,
        commandName,
        path: path.join(input.skillsDirPath, directoryName),
        reason: `Invalid Claude skill directory name '${directoryName}'.`,
      });
      continue;
    }

    const skillDirectoryPath = path.join(input.skillsDirPath, directoryName);
    const resolvedSkillDirectoryPath = path.resolve(skillDirectoryPath);
    const relativeSkillDirectoryPath = path.relative(
      resolvedSkillsDirPath,
      resolvedSkillDirectoryPath,
    );
    if (
      relativeSkillDirectoryPath === "" ||
      relativeSkillDirectoryPath.startsWith("..") ||
      path.isAbsolute(relativeSkillDirectoryPath)
    ) {
      warnings.push({
        scope: input.scope,
        commandName,
        path: skillDirectoryPath,
        reason: `Claude skill directory '${directoryName}' resolves outside the skills root.`,
      });
      continue;
    }
    const directoryInfo = yield* fs
      .stat(skillDirectoryPath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!directoryInfo || directoryInfo.type !== "Directory") {
      continue;
    }

    watchPaths.add(skillDirectoryPath);

    if (isReservedProjectSkillCommandName(commandName)) {
      warnings.push({
        scope: input.scope,
        commandName,
        path: skillDirectoryPath,
        reason: `Reserved command name '${commandName}' cannot be registered as a Claude skill.`,
      });
      continue;
    }

    const skillDocumentPath = path.join(skillDirectoryPath, "SKILL.md");
    const skillDocumentInfo = yield* fs
      .stat(skillDocumentPath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!skillDocumentInfo || skillDocumentInfo.type !== "File") {
      continue;
    }

    const documentText = yield* fs.readFileString(skillDocumentPath).pipe(
      Effect.catch((cause) => {
        warnings.push({
          scope: input.scope,
          commandName,
          path: skillDocumentPath,
          reason: `Failed to read SKILL.md: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
        return Effect.succeed(null);
      }),
    );
    if (documentText === null) {
      continue;
    }

    const parsed = yield* Effect.try({
      try: () =>
        parseClaudeSkillDocument({
          commandName,
          documentText,
        }),
      catch: (cause) =>
        new ProjectSkillParseError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }).pipe(
      Effect.match({
        onFailure: (error) => {
          warnings.push({
            scope: input.scope,
            commandName,
            path: skillDocumentPath,
            reason: error.message,
          });
          return null;
        },
        onSuccess: (parsed) => parsed,
      }),
    );
    if (!parsed) {
      continue;
    }

    candidates.push({
      id: skillIdForProject({
        projectId: input.projectId,
        commandName,
      }),
      projectId: input.projectId,
      scope: input.scope,
      commandName,
      displayName: parsed.displayName,
      description: parsed.description,
      argumentHint: parsed.argumentHint,
      allowedTools: parsed.allowedTools,
      paths: parsed.paths,
      updatedAt: (skillDocumentInfo.mtime ?? new Date(0)).toISOString(),
      canonicalPath: path.resolve(skillDirectoryPath),
    });
  }

  return {
    candidates,
    watchPaths: uniqueSortedPaths([...watchPaths]),
    warnings,
  };
});

function resolveProjectSkillCollisions(
  candidates: ReadonlyArray<ProjectSkillCandidate>,
): ReadonlyArray<ProjectSkill> {
  const winners = new Map<string, ProjectSkillCandidate>();

  const sortedCandidates = [...candidates].toSorted((left, right) => {
    const scopePriority = left.scope === right.scope ? 0 : left.scope === "project" ? -1 : 1;
    return (
      left.commandName.localeCompare(right.commandName) ||
      scopePriority ||
      left.canonicalPath.localeCompare(right.canonicalPath)
    );
  });

  for (const candidate of sortedCandidates) {
    if (!winners.has(candidate.commandName)) {
      winners.set(candidate.commandName, candidate);
    }
  }

  return [...winners.values()]
    .toSorted((left, right) => left.commandName.localeCompare(right.commandName))
    .map(({ canonicalPath: _canonicalPath, ...skill }) => skill);
}

export const scanProjectSkills = Effect.fn(function* (input: {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly userHome: string;
}): Effect.fn.Return<ProjectSkillScanResult, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;

  const userClaudeDirPath = path.join(input.userHome, ".claude");
  const userSkillsDirPath = path.join(userClaudeDirPath, "skills");
  const projectClaudeDirPath = path.join(input.workspaceRoot, ".claude");
  const projectSkillsDirPath = path.join(projectClaudeDirPath, "skills");

  const [userScope, projectScope] = yield* Effect.all([
    scanSkillScope({
      projectId: input.projectId,
      scope: "user",
      workspaceParentPath: input.userHome,
      claudeDirPath: userClaudeDirPath,
      skillsDirPath: userSkillsDirPath,
    }),
    scanSkillScope({
      projectId: input.projectId,
      scope: "project",
      workspaceParentPath: input.workspaceRoot,
      claudeDirPath: projectClaudeDirPath,
      skillsDirPath: projectSkillsDirPath,
    }),
  ]);

  return {
    skills: resolveProjectSkillCollisions([...userScope.candidates, ...projectScope.candidates]),
    watchPaths: uniqueSortedPaths([...userScope.watchPaths, ...projectScope.watchPaths]),
    warnings: [...userScope.warnings, ...projectScope.warnings],
  };
});
