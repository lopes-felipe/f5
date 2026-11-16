import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseDesktopUpdateManifest,
  type DesktopUpdateManifest as MacUpdateManifest,
  type DesktopUpdateFile as MacUpdateFile,
  type DesktopUpdateScalar as MacUpdateScalar,
} from "./desktop-update-manifest.ts";

export function parseMacUpdateManifest(raw: string, sourcePath: string): MacUpdateManifest {
  const manifest = parseDesktopUpdateManifest(raw, sourcePath, false);
  const { path: _path, sha512: _sha512, ...extras } = manifest.extras;
  return { ...manifest, extras };
}

function mergeExtras(
  primary: Readonly<Record<string, MacUpdateScalar>>,
  secondary: Readonly<Record<string, MacUpdateScalar>>,
): Record<string, MacUpdateScalar> {
  const merged: Record<string, MacUpdateScalar> = { ...primary };

  for (const [key, value] of Object.entries(secondary)) {
    const existing = merged[key];
    if (existing !== undefined && existing !== value) {
      throw new Error(
        `Cannot merge macOS update manifests: conflicting '${key}' values ('${existing}' vs '${value}').`,
      );
    }
    merged[key] = value;
  }

  return merged;
}

export function mergeMacUpdateManifests(
  primary: MacUpdateManifest,
  secondary: MacUpdateManifest,
): MacUpdateManifest {
  if (primary.version !== secondary.version) {
    throw new Error(
      `Cannot merge macOS update manifests with different versions (${primary.version} vs ${secondary.version}).`,
    );
  }

  const filesByUrl = new Map<string, MacUpdateFile>();
  for (const file of [...primary.files, ...secondary.files]) {
    const existing = filesByUrl.get(file.url);
    if (existing && (existing.sha512 !== file.sha512 || existing.size !== file.size)) {
      throw new Error(
        `Cannot merge macOS update manifests: conflicting file entry for ${file.url}.`,
      );
    }
    filesByUrl.set(file.url, file);
  }

  return {
    version: primary.version,
    releaseDate:
      primary.releaseDate >= secondary.releaseDate ? primary.releaseDate : secondary.releaseDate,
    files: [...filesByUrl.values()],
    extras: mergeExtras(primary.extras, secondary.extras),
  };
}

function quoteYamlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function serializeScalarValue(value: MacUpdateScalar): string {
  if (typeof value === "string") {
    return quoteYamlString(value);
  }
  return String(value);
}

export function serializeMacUpdateManifest(manifest: MacUpdateManifest): string {
  const lines = [`version: ${manifest.version}`, "files:"];

  for (const file of manifest.files) {
    lines.push(`  - url: ${file.url}`);
    lines.push(`    sha512: ${file.sha512}`);
    lines.push(`    size: ${file.size}`);
  }

  for (const key of Object.keys(manifest.extras).toSorted()) {
    const value = manifest.extras[key];
    if (value === undefined) {
      throw new Error(`Cannot serialize macOS update manifest: missing value for '${key}'.`);
    }
    lines.push(`${key}: ${serializeScalarValue(value)}`);
  }

  lines.push(`releaseDate: ${quoteYamlString(manifest.releaseDate)}`);
  lines.push("");
  return lines.join("\n");
}

function main(args: ReadonlyArray<string>): void {
  const [arm64PathArg, x64PathArg, outputPathArg] = args;
  if (!arm64PathArg || !x64PathArg) {
    throw new Error(
      "Usage: node scripts/merge-mac-update-manifests.ts <latest-mac.yml> <latest-mac-x64.yml> [output-path]",
    );
  }

  const arm64Path = resolve(arm64PathArg);
  const x64Path = resolve(x64PathArg);
  const outputPath = resolve(outputPathArg ?? arm64PathArg);

  const arm64Manifest = parseMacUpdateManifest(readFileSync(arm64Path, "utf8"), arm64Path);
  const x64Manifest = parseMacUpdateManifest(readFileSync(x64Path, "utf8"), x64Path);
  const merged = mergeMacUpdateManifests(arm64Manifest, x64Manifest);
  writeFileSync(outputPath, serializeMacUpdateManifest(merged));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
