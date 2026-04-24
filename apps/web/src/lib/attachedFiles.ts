const TRAILING_ATTACHED_FILES_BLOCK_PATTERN =
  /\n*<attached_files>\n([\s\S]*?)\n<\/attached_files>\s*$/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/;
const UNC_PATH_PATTERN = /^\\\\/;

export function buildAttachedFilesBlock(filePaths: ReadonlyArray<string>): string {
  const normalizedFilePaths = normalizeAttachedFilePaths(filePaths);
  if (normalizedFilePaths.length === 0) {
    return "";
  }
  return [
    "<attached_files>",
    escapeHiddenBlockJson(JSON.stringify(normalizedFilePaths)),
    "</attached_files>",
  ].join("\n");
}

export function appendAttachedFilesToPrompt(
  prompt: string,
  filePaths: ReadonlyArray<string>,
): string {
  const attachedFilesBlock = buildAttachedFilesBlock(filePaths);
  if (attachedFilesBlock.length === 0) {
    return prompt;
  }
  return prompt.length > 0 ? `${prompt}\n\n${attachedFilesBlock}` : attachedFilesBlock;
}

export function extractTrailingAttachedFiles(prompt: string): {
  promptText: string;
  filePaths: string[];
} {
  const match = TRAILING_ATTACHED_FILES_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return {
      promptText: prompt,
      filePaths: [],
    };
  }

  let filePaths: string[] = [];
  try {
    const parsed = JSON.parse(match[1] ?? "") as unknown;
    if (Array.isArray(parsed)) {
      filePaths = normalizeAttachedFilePaths(
        parsed.filter((entry): entry is string => typeof entry === "string"),
      );
    }
  } catch {
    filePaths = [];
  }

  return {
    promptText: prompt.slice(0, match.index).replace(/\n+$/, ""),
    filePaths,
  };
}

export function relativePathForDisplay(
  filePath: string,
  workspaceRoot: string | undefined,
): string {
  const normalizedPath = normalizeDisplayPath(filePath);
  if (!workspaceRoot) {
    return normalizedPath;
  }

  const normalizedRoot = normalizeAbsolutePath(workspaceRoot);
  if (normalizedPath === normalizedRoot) {
    return normalizedPath;
  }

  const normalizedRootPrefix = `${normalizedRoot}/`;
  if (normalizedPath.startsWith(normalizedRootPrefix)) {
    return normalizedPath.slice(normalizedRootPrefix.length);
  }

  return looksLikeAbsolutePath(filePath) ? filePath : normalizedPath;
}

export function resolveAttachedFileReferencePath(
  filePath: string,
  workspaceRoots: ReadonlyArray<string | null | undefined>,
  options?: {
    normalizeAbsolutePathForComparison?:
      | ((pathValue: string) => string | null | undefined)
      | undefined;
  },
): string | null {
  if (filePath.length === 0 || filePath.includes("\0")) {
    return null;
  }

  if (!looksLikeAbsolutePath(filePath)) {
    return normalizeRelativeReferencePath(filePath);
  }

  const normalizedOriginalFilePath = normalizeAbsolutePath(filePath);
  const normalizedComparisonFilePath = normalizeAbsolutePath(
    options?.normalizeAbsolutePathForComparison?.(filePath) ?? filePath,
  );
  for (const workspaceRoot of workspaceRoots) {
    if (!workspaceRoot) {
      continue;
    }
    const normalizedOriginalRoot = normalizeAbsolutePath(workspaceRoot);
    const normalizedComparisonRoot = normalizeAbsolutePath(
      options?.normalizeAbsolutePathForComparison?.(workspaceRoot) ?? workspaceRoot,
    );
    if (normalizedComparisonRoot.length === 0) {
      continue;
    }

    const originalRelativePath = sliceContainedAbsolutePath(
      normalizedOriginalFilePath,
      normalizedOriginalRoot,
    );
    if (originalRelativePath !== null) {
      return normalizeRelativeReferencePath(originalRelativePath);
    }

    const comparisonRelativePath = sliceContainedAbsolutePath(
      normalizedComparisonFilePath,
      normalizedComparisonRoot,
    );
    if (comparisonRelativePath !== null) {
      return normalizeRelativeReferencePath(comparisonRelativePath);
    }
  }

  return normalizedOriginalFilePath.length > 0 ? normalizedOriginalFilePath : null;
}

export function normalizeAttachedFilePaths(filePaths: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const filePath of filePaths) {
    if (filePath.length === 0 || seen.has(filePath)) {
      continue;
    }
    seen.add(filePath);
    normalized.push(filePath);
  }

  return normalized;
}

export function sanitizeAttachedFileReferencePaths(input: {
  filePaths: ReadonlyArray<string>;
  workspaceRoots: ReadonlyArray<string | null | undefined>;
  normalizeAbsolutePathForComparison?:
    | ((pathValue: string) => string | null | undefined)
    | undefined;
}): {
  filePaths: string[];
  invalidPathCount: number;
} {
  let invalidPathCount = 0;
  const normalizedFilePaths: string[] = [];

  for (const filePath of input.filePaths) {
    const referencePath = resolveAttachedFileReferencePath(filePath, input.workspaceRoots, {
      normalizeAbsolutePathForComparison: input.normalizeAbsolutePathForComparison,
    });
    if (!referencePath) {
      invalidPathCount += 1;
      continue;
    }
    normalizedFilePaths.push(referencePath);
  }

  return {
    filePaths: normalizeAttachedFilePaths(normalizedFilePaths),
    invalidPathCount,
  };
}

function escapeHiddenBlockJson(json: string): string {
  return json.replaceAll("<", "\\u003C").replaceAll(">", "\\u003E");
}

function looksLikeAbsolutePath(filePath: string): boolean {
  return (
    filePath.startsWith("/") ||
    WINDOWS_DRIVE_PATH_PATTERN.test(filePath) ||
    UNC_PATH_PATTERN.test(filePath)
  );
}

function normalizeAbsolutePath(filePath: string): string {
  return filePath.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
}

function normalizeAbsolutePathForContainmentComparison(filePath: string): string {
  const normalizedPath = normalizeAbsolutePath(filePath);
  return looksLikeWindowsPath(normalizedPath) ? normalizedPath.toLowerCase() : normalizedPath;
}

function normalizeRelativeReferencePath(filePath: string): string | null {
  const normalized = filePath
    .replace(/[\\/]+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized.includes("\0") ||
    normalized
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return null;
  }
  return normalized;
}

function normalizeDisplayPath(filePath: string): string {
  return filePath.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
}

function sliceContainedAbsolutePath(filePath: string, workspaceRoot: string): string | null {
  if (workspaceRoot.length === 0) {
    return null;
  }

  const comparableFilePath = normalizeAbsolutePathForContainmentComparison(filePath);
  const comparableWorkspaceRoot = normalizeAbsolutePathForContainmentComparison(workspaceRoot);
  if (comparableFilePath === comparableWorkspaceRoot) {
    return "";
  }

  const comparableWorkspacePrefix = `${comparableWorkspaceRoot}/`;
  if (!comparableFilePath.startsWith(comparableWorkspacePrefix)) {
    return null;
  }

  return filePath.slice(workspaceRoot.length + 1);
}

function looksLikeWindowsPath(filePath: string): boolean {
  return (
    WINDOWS_DRIVE_PATH_PATTERN.test(filePath) ||
    UNC_PATH_PATTERN.test(filePath) ||
    filePath.startsWith("//")
  );
}
