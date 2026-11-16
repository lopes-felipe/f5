export interface DesktopUpdateFile {
  readonly blockMapSize?: number;
  readonly url: string;
  readonly sha512: string;
  readonly size: number;
}

export type DesktopUpdateScalar = string | number | boolean;

export interface DesktopUpdateManifest {
  readonly version: string;
  readonly releaseDate: string;
  readonly files: ReadonlyArray<DesktopUpdateFile>;
  readonly extras: Readonly<Record<string, DesktopUpdateScalar>>;
}

interface MutableDesktopUpdateFile {
  blockMapSize?: number;
  url?: string;
  sha512?: string;
  size?: number;
}

function stripSingleQuotes(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function parseFileRecord(
  currentFile: MutableDesktopUpdateFile | null,
  sourcePath: string,
  lineNumber: number,
): DesktopUpdateFile | null {
  if (currentFile === null) {
    return null;
  }
  if (
    typeof currentFile.url !== "string" ||
    typeof currentFile.sha512 !== "string" ||
    typeof currentFile.size !== "number"
  ) {
    throw new Error(
      `Invalid desktop update manifest at ${sourcePath}:${lineNumber}: incomplete file entry.`,
    );
  }
  return {
    url: currentFile.url,
    sha512: currentFile.sha512,
    size: currentFile.size,
    ...(currentFile.blockMapSize === undefined ? {} : { blockMapSize: currentFile.blockMapSize }),
  };
}

function parseScalarValue(rawValue: string): DesktopUpdateScalar {
  const trimmed = rawValue.trim();
  const isQuoted = trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2;
  const value = isQuoted ? trimmed.slice(1, -1).replace(/''/g, "'") : trimmed;
  if (isQuoted) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}

export function parseDesktopUpdateManifest(
  raw: string,
  sourcePath: string,
  allowBlockMapSize = true,
): DesktopUpdateManifest {
  const lines = raw.split(/\r?\n/);
  const files: DesktopUpdateFile[] = [];
  const extras: Record<string, DesktopUpdateScalar> = {};
  let version: string | null = null;
  let releaseDate: string | null = null;
  let inFiles = false;
  let currentFile: MutableDesktopUpdateFile | null = null;

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;

    const fileUrlMatch = line.match(/^  - url:\s*(.+)$/);
    if (fileUrlMatch?.[1]) {
      const finalized = parseFileRecord(currentFile, sourcePath, lineNumber);
      if (finalized) files.push(finalized);
      currentFile = { url: stripSingleQuotes(fileUrlMatch[1].trim()) };
      inFiles = true;
      continue;
    }

    const fileShaMatch = line.match(/^    sha512:\s*(.+)$/);
    if (fileShaMatch?.[1]) {
      if (currentFile === null) {
        throw new Error(
          `Invalid desktop update manifest at ${sourcePath}:${lineNumber}: sha512 without a file entry.`,
        );
      }
      currentFile.sha512 = stripSingleQuotes(fileShaMatch[1].trim());
      continue;
    }

    const fileSizeMatch = line.match(/^    size:\s*(\d+)$/);
    if (fileSizeMatch?.[1]) {
      if (currentFile === null) {
        throw new Error(
          `Invalid desktop update manifest at ${sourcePath}:${lineNumber}: size without a file entry.`,
        );
      }
      currentFile.size = Number(fileSizeMatch[1]);
      continue;
    }

    const blockMapMatch = line.match(/^    blockMapSize:\s*(\d+)$/);
    if (allowBlockMapSize && blockMapMatch?.[1] && currentFile) {
      const size = Number(blockMapMatch[1]);
      if (!Number.isSafeInteger(size)) throw new Error(`Invalid blockMapSize in ${sourcePath}`);
      currentFile.blockMapSize = size;
      continue;
    }
    if (line === "files:") {
      inFiles = true;
      continue;
    }

    if (inFiles && currentFile !== null) {
      const finalized = parseFileRecord(currentFile, sourcePath, lineNumber);
      if (finalized) files.push(finalized);
      currentFile = null;
    }
    inFiles = false;

    const topLevelMatch = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/);
    if (!topLevelMatch?.[1] || topLevelMatch[2] === undefined) {
      throw new Error(
        `Invalid desktop update manifest at ${sourcePath}:${lineNumber}: unsupported line '${line}'.`,
      );
    }

    const [, key, rawValue] = topLevelMatch;
    const value = parseScalarValue(rawValue);

    if (key === "version") {
      if (typeof value !== "string") {
        throw new Error(
          `Invalid desktop update manifest at ${sourcePath}:${lineNumber}: version must be a string.`,
        );
      }
      version = value;
      continue;
    }

    if (key === "releaseDate") {
      if (typeof value !== "string") {
        throw new Error(
          `Invalid desktop update manifest at ${sourcePath}:${lineNumber}: releaseDate must be a string.`,
        );
      }
      releaseDate = value;
      continue;
    }

    extras[key] = value;
  }

  const finalized = parseFileRecord(currentFile, sourcePath, lines.length);
  if (finalized) files.push(finalized);

  if (!version) {
    throw new Error(`Invalid desktop update manifest at ${sourcePath}: missing version.`);
  }
  if (!releaseDate) {
    throw new Error(`Invalid desktop update manifest at ${sourcePath}: missing releaseDate.`);
  }
  if (files.length === 0) {
    throw new Error(`Invalid desktop update manifest at ${sourcePath}: missing files.`);
  }

  return {
    version,
    releaseDate,
    files,
    extras,
  };
}
