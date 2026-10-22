/**
 * `bun run upstream-ports:check`: validates the v7 upstream ledger in the
 * working tree. Ledger-state files are written only by F5's Upstream page.
 *
 * Environment:
 * - F5_UPSTREAM_PORTS_ROOT: repository root (defaults to this checkout).
 * - F5_REQUIRE_UPSTREAM=1: fail when the configured upstream remote is missing.
 * - F5_LEDGER_BASE_REF: enables immutability and ledger-only PR rules against that ref.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { parseCheckedInProjectFile } from "@t3tools/shared/checkedInProjectFile";
import {
  ARCHIVE_PATH,
  LEDGER_STATE_DIRS,
  POLICY_PATH,
  RULES_PATH,
  deriveTopicState,
  evaluateBaseRefRules,
  indexEpochs,
  localDate,
  parseLedgerFiles,
  parseRules,
  parseUpstreamTopicTrailers,
  validateLedger,
  validatePolicy,
  validateProvenance,
  type ChangedPath,
  type RunGitSync,
} from "@t3tools/shared/upstreamPorts";
import {
  archiveContext,
  parseArchive,
  pendingArchiveShas,
  validateArchive,
  validateArchiveProvenance,
} from "@t3tools/shared/upstreamPortsArchive";

export function normalizeRepositoryUrl(url: string): string {
  return url
    .trim()
    .replace(/^git@github\.com:/u, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//u, "https://github.com/")
    .replace(/\.git\/?$/u, "")
    .replace(/\/$/u, "")
    .toLowerCase();
}

export interface CheckOptions {
  readonly root: string;
  readonly requireUpstream: boolean;
  readonly baseRef: string | undefined;
  readonly runGit: RunGitSync;
  readonly today: string;
}

export interface CheckResult {
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly summary: string | null;
}

function readLedgerStateFiles(ledgerRoot: string, errors: string[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const dir of LEDGER_STATE_DIRS) {
    const absolute = path.join(ledgerRoot, dir);
    if (!existsSync(absolute)) continue;
    for (const name of readdirSync(absolute)) {
      const relative = `${dir}/${name}`;
      if (!name.endsWith(".json") || !statSync(path.join(absolute, name)).isFile()) {
        errors.push(`${relative}: unexpected file in a ledger-state directory`);
        continue;
      }
      files.set(relative, readFileSync(path.join(absolute, name), "utf8"));
    }
  }
  return files;
}

/** `git diff -z --name-status --no-renames`: NUL-separated status and path pairs, never quoted. */
export function parseNameStatusZ(output: string): ChangedPath[] {
  const fields = output.split("\0");
  const changes: ChangedPath[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index]!;
    if (!status) break;
    changes.push({ status: status.slice(0, 1), path: fields[index + 1]! });
  }
  return changes;
}

function tryGit(runGit: RunGitSync, args: ReadonlyArray<string>): string | null {
  try {
    return runGit(args);
  } catch {
    return null;
  }
}

export function checkUpstreamPorts(options: CheckOptions): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const projectFile = path.join(options.root, "f5.json");
  if (!existsSync(projectFile))
    return {
      errors: ["f5.json is missing; it must declare the upstream block"],
      warnings,
      summary: null,
    };
  const parsedProject = parseCheckedInProjectFile(readFileSync(projectFile, "utf8"));
  for (const diagnostic of parsedProject.diagnostics)
    if (diagnostic.field === "upstream") errors.push(`f5.json: ${diagnostic.message}`);
  const config = parsedProject.upstream;
  if (!config) {
    if (!errors.length) errors.push("f5.json has no upstream block");
    return { errors, warnings, summary: null };
  }
  const ledgerRoot = path.join(options.root, config.ledgerDir);
  const read = (relative: string) => {
    const file = path.join(ledgerRoot, relative);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  };

  const archiveText = read(ARCHIVE_PATH);
  if (archiveText === null) {
    errors.push(`${config.ledgerDir}/${ARCHIVE_PATH} is missing`);
    return { errors, warnings, summary: null };
  }
  let archive;
  try {
    archive = parseArchive(archiveText);
  } catch (error) {
    errors.push(`${config.ledgerDir}/${ARCHIVE_PATH}: ${String(error)}`);
    return { errors, warnings, summary: null };
  }
  const archiveErrors = validateArchive(archive);
  if (archiveErrors.length) {
    // The archive context below assumes a structurally valid archive.
    errors.push(...archiveErrors);
    return { errors, warnings, summary: null };
  }
  const pending = pendingArchiveShas(archive);
  if (pending.length) errors.push(`archive has pending records: ${pending.join(", ")}`);
  const context = archiveContext(archive);

  const rulesText = read(RULES_PATH);
  const parsedRules = rulesText === null ? null : parseRules(rulesText);
  if (!parsedRules) errors.push(`${config.ledgerDir}/${RULES_PATH} is missing`);
  else errors.push(...parsedRules.errors);
  const policyText = read(POLICY_PATH);
  if (policyText === null) errors.push(`${config.ledgerDir}/${POLICY_PATH} is missing`);
  else errors.push(...validatePolicy(policyText));

  const parsedLedger = parseLedgerFiles(readLedgerStateFiles(ledgerRoot, errors));
  errors.push(...parsedLedger.errors);
  const ledger = parsedLedger.ledger;
  errors.push(...validateLedger(ledger, { rules: parsedRules?.rules ?? null, archive: context }));

  const remoteUrl = tryGit(options.runGit, ["remote", "get-url", config.remote]);
  if (remoteUrl === null) {
    if (options.requireUpstream)
      errors.push(`the ${config.remote} remote is required but is not configured`);
    else warnings.push(`${config.remote} remote is unavailable; provenance check skipped`);
  } else if (normalizeRepositoryUrl(remoteUrl) !== normalizeRepositoryUrl(config.repository)) {
    errors.push(`${config.remote} remote URL ${remoteUrl} does not match ${config.repository}`);
  } else {
    const remoteRef = `refs/remotes/${config.remote}/${config.branch}`;
    if (tryGit(options.runGit, ["rev-parse", "--verify", "--quiet", remoteRef]) === null) {
      if (options.requireUpstream) errors.push(`${remoteRef} is not fetched`);
      else warnings.push(`${remoteRef} is not fetched; provenance check skipped`);
    } else {
      errors.push(...validateArchiveProvenance(archive, options.runGit, remoteRef));
      errors.push(...validateProvenance(ledger.intervals, options.runGit, remoteRef));
    }
  }

  if (options.baseRef) {
    const changes = parseNameStatusZ(
      options.runGit(["diff", "-z", "--name-status", "--no-renames", `${options.baseRef}...HEAD`]),
    );
    const baseProject = tryGit(options.runGit, ["show", `${options.baseRef}:f5.json`]);
    const baseLedgerDir =
      baseProject === null
        ? null
        : (parseCheckedInProjectFile(baseProject).upstream?.ledgerDir ?? null);
    const ledgerDirs = [config.ledgerDir, ...(baseLedgerDir === null ? [] : [baseLedgerDir])];
    const baseHasArchive = ledgerDirs.some(
      (dir) =>
        tryGit(options.runGit, ["cat-file", "-e", `${options.baseRef}:${dir}/${ARCHIVE_PATH}`]) !==
        null,
    );
    errors.push(...evaluateBaseRefRules({ ledgerDirs, changes, baseHasArchive }));
  }

  const topics = new Map(ledger.topics.map((topic) => [topic.id, topic]));
  const headMessages =
    tryGit(
      options.runGit,
      options.baseRef
        ? ["log", "--format=%B", `${options.baseRef}..HEAD`]
        : ["log", "-1", "--format=%B"],
    ) ?? "";
  for (const trailer of parseUpstreamTopicTrailers(headMessages)) {
    const topic = topics.get(trailer.id);
    if (!topic) warnings.push(`Upstream-Topic trailer names unknown topic ${trailer.id}`);
    else if (trailer.epoch > topic.epoch)
      warnings.push(
        `Upstream-Topic trailer ${trailer.id}#${trailer.epoch} is newer than the ledger epoch ${topic.epoch}`,
      );
  }

  const trailerLog =
    tryGit(options.runGit, ["log", "HEAD", "--format=%B", "-E", "--grep=^Upstream-Topic: "]) ?? "";
  const trailers = indexEpochs(parseUpstreamTopicTrailers(trailerLog));
  const counts = { inbox: 0, port: 0, watch: 0, done: 0, skipped: 0 };
  for (const topic of ledger.topics) {
    const state = deriveTopicState(topic, {
      trailers,
      activeLinks: new Map(),
      today: options.today,
    });
    counts[state === "ready" || state === "in-progress" ? "port" : state] += 1;
  }
  const target = ledger.intervals.at(-1)?.targetSha ?? context.lastTargetSha;
  const summary = `Upstream ledger: ${ledger.topics.length} topics (inbox ${counts.inbox}, port ${counts.port}, watch ${counts.watch}, done ${counts.done}, skipped ${counts.skipped}); ${ledger.intervals.length} intervals, ${ledger.legacy.length} legacy batches; tracked through ${target.slice(0, 12)}.`;
  return { errors, warnings, summary };
}

if (import.meta.main) {
  const root = path.resolve(
    process.env.F5_UPSTREAM_PORTS_ROOT ?? path.join(import.meta.dirname, ".."),
  );
  const runGit: RunGitSync = (args) =>
    execFileSync("git", [...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  try {
    const result = checkUpstreamPorts({
      root,
      requireUpstream: process.env.F5_REQUIRE_UPSTREAM === "1",
      baseRef: process.env.F5_LEDGER_BASE_REF || undefined,
      runGit,
      today: localDate(new Date()),
    });
    for (const warning of result.warnings) console.warn(`upstream ports: warning: ${warning}`);
    if (result.summary) console.log(result.summary);
    if (result.errors.length) {
      for (const error of result.errors) console.error(`upstream ports: ${error}`);
      process.exitCode = 1;
    } else {
      console.log("Upstream port ledger valid.");
    }
  } catch (error) {
    console.error(`upstream ports: ${String(error)}`);
    process.exitCode = 1;
  }
}
