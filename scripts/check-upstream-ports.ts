import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { classifyCommit } from "./upstream-port-suggestions.ts";
import {
  AUTHORITATIVE_REPOSITORY,
  selectRefreshHead,
  verifyUpstream,
} from "./upstream-port-history.ts";
import { readPortFiles, writePortFiles } from "./upstream-port-files.ts";
import {
  DISPOSITIONS,
  SHA_PATTERN,
  SHA256_PATTERN,
  makeAudit,
  refreshEntries,
  sha256,
  validateAudit,
  type FrozenCommit,
  type Ledger,
} from "./upstream-port-ledger.ts";

const ROOT = process.env.F5_UPSTREAM_PORTS_ROOT
  ? path.resolve(process.env.F5_UPSTREAM_PORTS_ROOT)
  : path.resolve(import.meta.dirname, "..");
const MANIFEST_PATH = process.env.F5_UPSTREAM_PORTS_MANIFEST_PATH
  ? path.resolve(process.env.F5_UPSTREAM_PORTS_MANIFEST_PATH)
  : path.join(ROOT, "scripts", "upstream-ports.manifest.json");
const LEDGER_PATH = process.env.F5_UPSTREAM_PORTS_LEDGER_PATH
  ? path.resolve(process.env.F5_UPSTREAM_PORTS_LEDGER_PATH)
  : path.join(ROOT, "scripts", "upstream-ports.json");

const LOCAL_MIRROR = "developer-local convenience checkout (not authoritative)";
const WINDOW_SIZE = 500;

interface Manifest {
  readonly schemaVersion: 1;
  readonly upstream: {
    readonly authoritativeRepository: string;
    readonly localMirror: string;
    readonly localMirrorAuthoritative: false;
  };
  readonly selection: {
    readonly rule: "first-parent";
    readonly maxCount: 500;
    readonly headSha: string;
    readonly boundarySha: string;
    readonly firstSha: string;
    readonly lastSha: string;
    readonly count: number;
  };
  readonly commits: ReadonlyArray<FrozenCommit>;
}

function git(
  args: ReadonlyArray<string>,
  options?: { readonly cwd?: string; readonly input?: string },
): string {
  return execFileSync("git", [...args], {
    cwd: options?.cwd ?? ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...(options?.input !== undefined ? { input: options.input } : {}),
    stdio: [options?.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
  }).trim();
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`could not parse ${path.relative(ROOT, filePath)}: ${String(error)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifest(filePath: string): Manifest {
  const value = readJson(filePath);
  if (
    !isRecord(value) ||
    !isRecord(value.upstream) ||
    !isRecord(value.selection) ||
    !Array.isArray(value.commits) ||
    value.commits.some((commit) => !isRecord(commit))
  ) {
    throw new Error("manifest must contain upstream, selection, and a commits array");
  }
  return value as unknown as Manifest;
}

function readLedger(filePath: string): Ledger {
  const value = readJson(filePath);
  const validStringArray = (candidate: unknown): boolean =>
    candidate === undefined ||
    (Array.isArray(candidate) && candidate.every((entry) => typeof entry === "string"));
  if (
    !isRecord(value) ||
    !Array.isArray(value.entries) ||
    value.entries.some(
      (entry) =>
        !isRecord(entry) || !validStringArray(entry.f5Shas) || !validStringArray(entry.evidence),
    ) ||
    (value.historicalEntries !== undefined &&
      (!Array.isArray(value.historicalEntries) ||
        value.historicalEntries.some(
          (entry) =>
            !isRecord(entry) ||
            !validStringArray(entry.f5Shas) ||
            !validStringArray(entry.evidence),
        ))) ||
    (value.audit !== undefined &&
      (!isRecord(value.audit) ||
        !Array.isArray(value.audit.upstreamShas) ||
        !validStringArray(value.audit.upstreamShas))) ||
    !Array.isArray(value.olderBacklog) ||
    value.olderBacklog.some(
      (category) =>
        !isRecord(category) ||
        !validStringArray(category.upstreamShas) ||
        !validStringArray(category.promotedUpstreamShas) ||
        !validStringArray(category.f5Shas) ||
        !validStringArray(category.evidence),
    )
  ) {
    throw new Error("ledger must contain entries and olderBacklog arrays");
  }
  return value as unknown as Ledger;
}

function hasUpstreamRemote(): boolean {
  try {
    git(["remote", "get-url", "upstream"]);
    return true;
  } catch {
    return false;
  }
}

function fail(errors: string[]): never {
  for (const error of errors) {
    console.error(`upstream ports: ${error}`);
  }
  process.exit(1);
}

function assertNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateEvidence(
  owner: string,
  evidence: ReadonlyArray<string> | undefined,
  errors: string[],
): void {
  for (const value of evidence ?? []) {
    const match = /^(.+):([1-9][0-9]*)$/.exec(value);
    if (!match) {
      errors.push(`${owner} has malformed file:line evidence ${JSON.stringify(value)}`);
      continue;
    }
    const repositoryPath = match[1]!;
    const line = Number(match[2]);
    if (path.isAbsolute(repositoryPath) || repositoryPath.split(/[\\/]/).includes("..")) {
      errors.push(`${owner} evidence must be a repository-relative path: ${value}`);
      continue;
    }
    const absolutePath = path.resolve(ROOT, repositoryPath);
    if (!absolutePath.startsWith(`${ROOT}${path.sep}`)) {
      errors.push(`${owner} evidence escapes the repository: ${value}`);
      continue;
    }
    try {
      if (!statSync(absolutePath).isFile()) {
        errors.push(`${owner} evidence is not a file: ${value}`);
        continue;
      }
      const text = readFileSync(absolutePath, "utf8");
      const lineCount =
        text.length === 0 ? 0 : text.split(/\r?\n/).length - (/\r?\n$/.test(text) ? 1 : 0);
      if (line > lineCount) {
        errors.push(`${owner} evidence line is out of range (${lineCount} lines): ${value}`);
      }
    } catch {
      errors.push(`${owner} evidence file does not exist: ${value}`);
    }
  }
}

function frozenCommits(headSha: string): FrozenCommit[] {
  const recordSeparator = "\u001e";
  const fieldSeparator = "\u001f";
  const output = git([
    "log",
    "--first-parent",
    `--max-count=${WINDOW_SIZE}`,
    `--format=%H${fieldSeparator}%s${recordSeparator}`,
    headSha,
  ]);
  return output
    .split(recordSeparator)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const separatorIndex = record.indexOf(fieldSeparator);
      return {
        sha: record.slice(0, separatorIndex),
        subject: record.slice(separatorIndex + 1),
      };
    });
}

function firstParentShas(head: string): string[] {
  return git(["rev-list", "--first-parent", head]).split("\n").filter(Boolean);
}

function refresh(pin?: string): void {
  const files = { manifest: MANIFEST_PATH, ledger: LEDGER_PATH };
  const expected = readPortFiles(files);
  const headSha = selectRefreshHead(git, pin);
  const commits = frozenCommits(headSha);
  if (commits.length !== WINDOW_SIZE)
    fail([`expected ${WINDOW_SIZE} first-parent commits, received ${commits.length}`]);
  const previousLedger = readLedger(LEDGER_PATH);
  if (previousLedger.schemaVersion !== 4 && previousLedger.schemaVersion !== 5)
    fail(["unsupported ledger schemaVersion"]);
  const audit =
    previousLedger.audit ??
    makeAudit(
      git(["rev-parse", `${commits.at(-1)!.sha}^1`]),
      headSha,
      commits.map((commit) => commit.sha),
    );

  const manifest: Manifest = {
    schemaVersion: 1,
    upstream: {
      authoritativeRepository: AUTHORITATIVE_REPOSITORY,
      localMirror: LOCAL_MIRROR,
      localMirrorAuthoritative: false,
    },
    selection: {
      rule: "first-parent",
      maxCount: WINDOW_SIZE,
      headSha,
      boundarySha: commits.at(-1)!.sha,
      firstSha: commits[0]!.sha,
      lastSha: commits.at(-1)!.sha,
      count: commits.length,
    },
    commits,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const ledger: Ledger = {
    schemaVersion: 5,
    manifest: "scripts/upstream-ports.manifest.json",
    manifestSha256: sha256(manifestText),
    ...refreshEntries(previousLedger, commits, classifyCommit),
    audit,
  };

  writePortFiles(files, expected, {
    manifest: manifestText,
    ledger: `${JSON.stringify(ledger, null, 2)}\n`,
  });
  console.log(`Frozen ${commits.length} commits at ${headSha}.`);
}

function validate(): void {
  const errors: string[] = [];
  let manifest: Manifest;
  let ledger: Ledger;
  try {
    readPortFiles({ manifest: MANIFEST_PATH, ledger: LEDGER_PATH });
    manifest = readManifest(MANIFEST_PATH);
    ledger = readLedger(LEDGER_PATH);
  } catch (error) {
    fail([String(error)]);
  }

  if (manifest.schemaVersion !== 1) errors.push("unsupported manifest schemaVersion");
  if (ledger.schemaVersion !== 4 && ledger.schemaVersion !== 5)
    errors.push("unsupported ledger schemaVersion");
  if (ledger.manifest !== "scripts/upstream-ports.manifest.json")
    errors.push("ledger references an unsupported manifest path");
  const manifestText = readFileSync(MANIFEST_PATH, "utf8");
  if (!SHA256_PATTERN.test(ledger.manifestSha256)) {
    errors.push("ledger manifestSha256 is missing or invalid");
  } else if (ledger.manifestSha256 !== sha256(manifestText)) {
    errors.push("checked-in manifest does not match the ledger integrity digest");
  }
  if (manifest.upstream.authoritativeRepository !== AUTHORITATIVE_REPOSITORY) {
    errors.push("manifest authoritative repository does not match pingdotgg/t3code");
  }
  if (manifest.upstream.localMirrorAuthoritative !== false) {
    errors.push("the local convenience mirror must never be marked authoritative");
  }
  if (
    manifest.selection.rule !== "first-parent" ||
    manifest.selection.maxCount !== WINDOW_SIZE ||
    manifest.selection.count !== WINDOW_SIZE
  ) {
    errors.push("manifest selection must be exactly 500 first-parent commits");
  }
  if (manifest.commits.length !== WINDOW_SIZE) {
    errors.push(`manifest contains ${manifest.commits.length} commits instead of ${WINDOW_SIZE}`);
  }
  if (manifest.commits[0]?.sha !== manifest.selection.firstSha) {
    errors.push("manifest firstSha does not match its first commit");
  }
  if (manifest.selection.headSha !== manifest.selection.firstSha) {
    errors.push("manifest headSha must equal firstSha");
  }
  if (
    manifest.commits.at(-1)?.sha !== manifest.selection.lastSha ||
    manifest.selection.boundarySha !== manifest.selection.lastSha
  ) {
    errors.push("manifest boundary/last SHA does not match its final commit");
  }

  const manifestShas = new Set<string>();
  for (const [index, commit] of manifest.commits.entries()) {
    if (!SHA_PATTERN.test(commit.sha)) errors.push(`manifest commit ${index} has an invalid SHA`);
    if (!assertNonEmpty(commit.subject))
      errors.push(`manifest commit ${commit.sha} has no subject`);
    if (manifestShas.has(commit.sha)) errors.push(`duplicate manifest SHA ${commit.sha}`);
    manifestShas.add(commit.sha);
  }

  const ledgerShas = new Set<string>();
  const historical = ledger.historicalEntries ?? [];
  if (ledger.schemaVersion === 5) {
    if (!Array.isArray(ledger.historicalEntries))
      errors.push("schema 5 requires historicalEntries");
    errors.push(...validateAudit(ledger));
  }
  for (const entry of [...ledger.entries, ...historical]) {
    if (ledger.entries.includes(entry) && !manifestShas.has(entry.upstreamSha)) {
      errors.push(`ledger SHA ${entry.upstreamSha} is not in the frozen manifest`);
    }
    if (ledgerShas.has(entry.upstreamSha)) errors.push(`duplicate ledger SHA ${entry.upstreamSha}`);
    ledgerShas.add(entry.upstreamSha);
    if (!SHA_PATTERN.test(entry.upstreamSha))
      errors.push(`invalid ledger SHA ${entry.upstreamSha}`);
    if (!assertNonEmpty(entry.subject))
      errors.push(`ledger SHA ${entry.upstreamSha} has no subject`);
    if (historical.includes(entry) && manifestShas.has(entry.upstreamSha))
      errors.push(`historical SHA ${entry.upstreamSha} overlaps frozen manifest`);
    if (ledger.schemaVersion === 5) {
      if (!["pending", "reviewed", "legacy"].includes(entry.reviewStatus ?? ""))
        errors.push(`ledger SHA ${entry.upstreamSha} has invalid reviewStatus`);
      if (
        entry.reviewStatus === "pending" ||
        /requires manual.*assessment|manual assessment placeholder/i.test(entry.reason ?? "")
      )
        errors.push(
          `ledger SHA ${entry.upstreamSha} requires review; generic manual assessment is not an audited disposition`,
        );
      if (entry.plannedWorkstream !== undefined && !assertNonEmpty(entry.plannedWorkstream))
        errors.push(`ledger SHA ${entry.upstreamSha} has empty plannedWorkstream`);
    }
    if (!DISPOSITIONS.includes(entry.disposition)) {
      errors.push(`ledger SHA ${entry.upstreamSha} has invalid disposition ${entry.disposition}`);
      continue;
    }
    const completed =
      entry.disposition === "ported" ||
      entry.disposition === "already-present" ||
      entry.disposition === "equivalent";
    if (completed && (!entry.f5Shas || entry.f5Shas.length === 0)) {
      errors.push(`completed ledger SHA ${entry.upstreamSha} has no f5 SHA`);
    }
    if (!completed && !assertNonEmpty(entry.reason)) {
      errors.push(`skipped/deferred ledger SHA ${entry.upstreamSha} has no concrete reason`);
    }
    if (
      (entry.disposition === "already-present" || entry.disposition === "equivalent") &&
      (!entry.evidence || entry.evidence.length === 0)
    ) {
      errors.push(`already-present ledger SHA ${entry.upstreamSha} has no file:line evidence`);
    }
    validateEvidence(`ledger SHA ${entry.upstreamSha}`, entry.evidence, errors);
    for (const f5Sha of entry.f5Shas ?? []) {
      if (!SHA_PATTERN.test(f5Sha)) {
        errors.push(`ledger SHA ${entry.upstreamSha} has invalid f5 SHA ${f5Sha}`);
      }
    }
  }
  for (const sha of manifestShas) {
    if (!ledgerShas.has(sha)) errors.push(`manifest SHA ${sha} is missing from the ledger`);
  }

  const olderShas = new Set<string>();
  for (const category of ledger.olderBacklog) {
    if (!assertNonEmpty(category.category) || !assertNonEmpty(category.selection)) {
      errors.push("older-backlog categories require a name and selection rule");
    }
    if (!assertNonEmpty(category.reason)) {
      errors.push(`older-backlog category ${category.category} has no reason`);
    }
    if (!DISPOSITIONS.includes(category.disposition)) {
      errors.push(`older-backlog category ${category.category} has an invalid disposition`);
      continue;
    }
    const completed =
      category.disposition === "ported" || category.disposition === "already-present";
    if (completed && !category.upstreamShas?.length && !category.promotedUpstreamShas?.length) {
      errors.push(`completed older-backlog category ${category.category} has no upstream SHA`);
    }
    if (completed && (!category.f5Shas || category.f5Shas.length === 0)) {
      errors.push(`completed older-backlog category ${category.category} has no f5 SHA`);
    }
    if (
      category.disposition === "already-present" &&
      (!category.evidence || category.evidence.length === 0)
    ) {
      errors.push(`already-present older-backlog category ${category.category} has no evidence`);
    }
    if (
      category.disposition !== "already-present" &&
      category.evidence &&
      category.evidence.length > 0
    ) {
      errors.push(
        `older-backlog category ${category.category} has evidence outside already-present disposition`,
      );
    }
    validateEvidence(`older-backlog category ${category.category}`, category.evidence, errors);
    for (const sha of category.upstreamShas ?? []) {
      if (!SHA_PATTERN.test(sha)) errors.push(`older-backlog category has invalid SHA ${sha}`);
      if (ledgerShas.has(sha)) errors.push(`older-backlog SHA ${sha} overlaps the frozen manifest`);
      if (olderShas.has(sha)) errors.push(`duplicate older-backlog SHA ${sha}`);
      olderShas.add(sha);
    }
    for (const sha of category.promotedUpstreamShas ?? []) {
      if (!SHA_PATTERN.test(sha) || !ledgerShas.has(sha))
        errors.push(`promoted backlog SHA ${sha} has no per-SHA record`);
    }
    for (const f5Sha of category.f5Shas ?? []) {
      if (!SHA_PATTERN.test(f5Sha)) {
        errors.push(`older-backlog category ${category.category} has invalid f5 SHA ${f5Sha}`);
      }
    }
  }

  const requireUpstream = process.env.F5_REQUIRE_UPSTREAM === "1";
  if (hasUpstreamRemote()) {
    try {
      verifyUpstream(git);
      if (!firstParentShas("upstream/main").includes(manifest.selection.headSha))
        throw new Error("frozen head is not on upstream/main first-parent ancestry");
      if (ledger.schemaVersion === 5 && ledger.audit) {
        const actualAudit = firstParentShas(ledger.audit.targetSha);
        const boundary = actualAudit.indexOf(ledger.audit.baseSha);
        if (
          boundary < 0 ||
          JSON.stringify(actualAudit.slice(0, boundary)) !==
            JSON.stringify(ledger.audit.upstreamShas)
        )
          errors.push("audit selection differs from upstream first-parent interval");
      }
      const actual = frozenCommits(manifest.selection.headSha);
      if (JSON.stringify(actual) !== JSON.stringify(manifest.commits)) {
        errors.push("checked-in manifest differs from the frozen upstream commit set");
      }
      for (const sha of new Set([...olderShas, ...historical.map((entry) => entry.upstreamSha)])) {
        git(["cat-file", "-e", `${sha}^{commit}`]);
      }
    } catch (error) {
      errors.push(`could not resolve frozen upstream history locally: ${String(error)}`);
    }
  } else if (requireUpstream) {
    errors.push("the authoritative upstream remote is required but is not configured");
  } else {
    console.warn(
      "upstream ports: authoritative upstream remote is unavailable; provenance check skipped",
    );
  }

  if (errors.length > 0) fail(errors);
  console.log(
    `Upstream port ledger valid: ${ledger.entries.length} frozen commits, ${ledger.olderBacklog.length} older categories.`,
  );
}

try {
  const args = process.argv.slice(2);
  let refreshRequested = false;
  let pin: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--refresh" && !refreshRequested) refreshRequested = true;
    else if (args[index] === "--head" && pin === undefined && args[index + 1]) pin = args[++index];
    else fail([`unknown or duplicate argument: ${args[index]}`]);
  }
  if (pin !== undefined && !refreshRequested) fail(["--head requires --refresh"]);
  if (refreshRequested) refresh(pin);
  else validate();
} catch (error) {
  fail([String(error)]);
}
