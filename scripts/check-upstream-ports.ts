import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.env.F5_UPSTREAM_PORTS_ROOT
  ? path.resolve(process.env.F5_UPSTREAM_PORTS_ROOT)
  : path.resolve(import.meta.dirname, "..");
const MANIFEST_PATH = process.env.F5_UPSTREAM_PORTS_MANIFEST_PATH
  ? path.resolve(process.env.F5_UPSTREAM_PORTS_MANIFEST_PATH)
  : path.join(ROOT, "scripts", "upstream-ports.manifest.json");
const LEDGER_PATH = process.env.F5_UPSTREAM_PORTS_LEDGER_PATH
  ? path.resolve(process.env.F5_UPSTREAM_PORTS_LEDGER_PATH)
  : path.join(ROOT, "scripts", "upstream-ports.json");
const AUTHORITATIVE_REPOSITORY = "https://github.com/pingdotgg/t3code.git";
const LOCAL_MIRROR = "developer-local convenience checkout (not authoritative)";
const WINDOW_SIZE = 500;

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DISPOSITIONS = new Set(["ported", "already-present", "not-applicable", "deferred"]);

type Disposition = "ported" | "already-present" | "not-applicable" | "deferred";

interface FrozenCommit {
  readonly sha: string;
  readonly subject: string;
}

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

interface LedgerEntry {
  readonly upstreamSha: string;
  readonly subject: string;
  readonly disposition: Disposition;
  readonly reason?: string;
  readonly f5Shas?: ReadonlyArray<string>;
  readonly evidence?: ReadonlyArray<string>;
}

interface OlderBacklogCategory {
  readonly category: string;
  readonly selection: string;
  readonly disposition: Disposition;
  readonly reason: string;
  readonly upstreamShas?: ReadonlyArray<string>;
  readonly f5Shas?: ReadonlyArray<string>;
  readonly evidence?: ReadonlyArray<string>;
}

interface Ledger {
  readonly schemaVersion: 3;
  readonly manifest: "scripts/upstream-ports.manifest.json";
  readonly manifestSha256: string;
  readonly entries: ReadonlyArray<LedgerEntry>;
  readonly olderBacklog: ReadonlyArray<OlderBacklogCategory>;
}

const plannedPhaseByPrefix: Readonly<Record<string, string>> = {
  fbd77420: "1.1 four runtime modes",
  "40c0ab08": "1.2 Codex launch arguments and launch identity",
  a6c9b41f: "1.3 provider-visible pasted-image paths",
  c8ad4b81: "1.5 Windows ~/.local/bin resolution",
  "749baec3": "1.6 background task names",
  "7963cc70": "1.7 runtime mode per turn",
  "887dd6e4": "2.1 WebSocket compression and backpressure",
  "8de0aa24": "2.4 non-blocking Windows PATH hydration",
  "34b15a9a": "2.5 Git metadata caching",
  "5fcdefd0": "2.6 dead replayEvents RPC removal",
  a0419812: "3.1 pins and snoozes",
  "202e5609": "3.1 pins and snoozes",
  "9afef94a": "3.1 pins and snoozes",
  "5661c611": "3.1 pins and snoozes",
  "61b51ae0": "3.1 pins and snoozes",
  da6e1a96: "3.1 pins and snoozes",
  "5c9358ac": "3.2 race-safe titles",
  d37a9b09: "3.2 title regeneration",
  b2ee17d7: "3.3 shared thread actions",
  "65b005f1": "3.3 shared thread actions",
  f2d2fb2f: "3.4 durable prompt stash",
  "200fa826": "3.4 prompt stash",
  "752acbf6": "3.5 new-thread affordances",
  bdf99c17: "3.5 new-window thread creation",
  "239ef1c5": "3.5 new-thread shortcut copy",
  "51672b6e": "4.1 diff presentation policy",
  eea3ea4c: "4.1 diff presentation policy",
  "38cfc25e": "4.1 diff presentation policy",
  cbe80520: "4.2 pasted-image compression",
  f9730979: "4.2 deferred base64 encoding",
  "8ca4eec9": "4.3 explorer drag into composer",
  "4cfec8c1": "4.3 explorer context menus",
  bfc31507: "4.4 sidebar thread search",
  "4b71a2ae": "4.4 global full-text search",
  "1735e27d": "4.5 terminal selection actions",
  "5719e8ac": "4.6 fast-mode icon",
  "05eb0511": "4.7 unsent drafts in sidebar",
  b73232bd: "4.8 reset sidebar width",
  b54bfc93: "4.9 right-panel empty states",
  abc409c2: "5.2 project content search",
  e5c75470: "5.3 settings search and deep links",
  "1c9a6de2": "5.4 checked-in project configuration",
  "6dbffa02": "5.5 per-project workspace mode",
  "076e9048": "5.6 manual project icons",
  "10bca3f4": "5.7 source-control writing preferences",
  a2ca89aa: "6.2 Agents observability",
  c2f8cb7c: "6.2 running subagent count",
  "3da315e7": "7.1 bounded activity payloads",
  b4680cbf: "7.1 activity pagination",
  "6b73b3de": "7.2 anchored thread pagination",
  "8101cd04": "7.3 usage reporting",
  c842c6f5: "7.3 hourly usage reporting",
  "0ce7e56e": "7.4 PR details",
  "91a03e07": "7.4 PR details",
  cad2c936: "7.4 provider-neutral PR seam",
  "4f584da0": "8.1 appearance settings",
  "8eca2000": "8.1 configurable fonts",
  "85b1734d": "8.2 theme library",
  "083fa4ab": "8.2 OKLCH themes",
  f0b57ca2: "8.2 theme import/search",
  b91a000a: "8.2 theme duplication",
  "710fd0ee": "8.3 preview favicons",
  "72d673a8": "8.3 preview recents",
  "79fe11bc": "8.3 preview color scheme",
  "1f279732": "8.4 update release notes",
};

const explicitNonPortsByPrefix: Readonly<Record<string, string>> = {
  "7e01d33f": "Already equivalent: f5 uses a narrow desktop asar unpack list.",
  db1507e9: "Not applicable: f5 archives explicitly and has no automatic sidebar settling.",
  "31891a1a": "Divergent direction: f5 deliberately retains plan mode and streaming.",
  "48aa875c": "Divergent direction: f5 deliberately retains the Build/Plan composer control.",
  e60821f0: "Divergent direction: f5 model preferences already address model-menu crowding.",
  "2f41c073": "Divergent direction: f5 deliberately inherits new-thread workspace context.",
  "95305c36":
    "Rejected on security grounds: browser-local executable selection would be privilege escalation.",
  acf761b2: "Deferred pending a cross-platform Ghostty/Electron packaging spike.",
  b28f9bf0: "Deferred until the provider-neutral GitHub PR detail seam is complete.",
};

function git(args: ReadonlyArray<string>, options?: { readonly cwd?: string }): string {
  return execFileSync("git", [...args], {
    cwd: options?.cwd ?? ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
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
    !Array.isArray(value.olderBacklog) ||
    value.olderBacklog.some(
      (category) =>
        !isRecord(category) ||
        !validStringArray(category.upstreamShas) ||
        !validStringArray(category.f5Shas) ||
        !validStringArray(category.evidence),
    )
  ) {
    throw new Error("ledger must contain entries and olderBacklog arrays");
  }
  return value as unknown as Ledger;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRepositoryUrl(value: string): string {
  return value
    .trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git\/?$/, "")
    .replace(/\/$/, "");
}

function verifyAuthoritativeRemote(): void {
  const fetchUrl = git(["remote", "get-url", "upstream"]);
  if (normalizeRepositoryUrl(fetchUrl) !== normalizeRepositoryUrl(AUTHORITATIVE_REPOSITORY)) {
    throw new Error(`upstream fetch URL is not authoritative: ${fetchUrl}`);
  }
  const pushUrls = git(["remote", "get-url", "--push", "--all", "upstream"])
    .split("\n")
    .filter(Boolean);
  if (pushUrls.length === 0 || pushUrls.some((url) => url !== "DISABLED")) {
    throw new Error("upstream must have its push URL disabled");
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

function resolvePrefix<T>(sha: string, values: Readonly<Record<string, T>>): T | undefined {
  for (const [prefix, value] of Object.entries(values)) {
    if (sha.startsWith(prefix)) return value;
  }
  return undefined;
}

function isNonProductCommit(subject: string): boolean {
  return /^(?:chore|ci|test|docs|refactor|build)(?:\([^)]*\))?:/i.test(subject);
}

function classifyCommit(commit: FrozenCommit): LedgerEntry {
  const base = { upstreamSha: commit.sha, subject: commit.subject };
  const explicitNonPort = resolvePrefix(commit.sha, explicitNonPortsByPrefix);
  if (explicitNonPort) {
    return {
      ...base,
      disposition: explicitNonPort.startsWith("Deferred") ? "deferred" : "not-applicable",
      reason: explicitNonPort,
    };
  }

  const plannedPhase = resolvePrefix(commit.sha, plannedPhaseByPrefix);
  if (plannedPhase) {
    return {
      ...base,
      disposition: "deferred",
      reason: `Scheduled for merged plan item ${plannedPhase}; pending its f5-native implementation commit.`,
    };
  }

  if (/\bmobile\b/i.test(commit.subject)) {
    return {
      ...base,
      disposition: "not-applicable",
      reason: "Not applicable: f5 has no mobile application product line.",
    };
  }
  if (/\b(?:connect|relay|pairing|hosted)\b/i.test(commit.subject)) {
    return {
      ...base,
      disposition: "not-applicable",
      reason:
        "Not applicable: f5 uses its existing remote-access model and has no managed relay product line.",
    };
  }
  if (isNonProductCommit(commit.subject)) {
    return {
      ...base,
      disposition: "not-applicable",
      reason: `No user-facing port: upstream-only maintenance (${commit.subject}).`,
    };
  }
  return {
    ...base,
    disposition: "deferred",
    reason: `Outside the reviewed merged port set; retain for a later f5-native user-impact assessment (${commit.subject}).`,
  };
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

function refresh(): void {
  try {
    verifyAuthoritativeRemote();
    git(["fetch", "--no-tags", "upstream", "main"]);
  } catch (error) {
    fail([`refusing to refresh from an unverified upstream remote: ${String(error)}`]);
  }
  const headSha = git(["rev-parse", "upstream/main"]);
  const commits = frozenCommits(headSha);
  if (commits.length !== WINDOW_SIZE) {
    fail([`expected ${WINDOW_SIZE} first-parent commits, received ${commits.length}`]);
  }

  let previousLedger: Ledger | null = null;
  let legacyShas: string[] = [];
  try {
    const previous = readJson(LEDGER_PATH);
    if (isRecord(previous) && !("schemaVersion" in previous)) {
      legacyShas = Object.keys(previous).filter((sha) => SHA_PATTERN.test(sha));
    } else if (isRecord(previous)) {
      previousLedger = readLedger(LEDGER_PATH);
    }
  } catch (error) {
    fail([`refusing to overwrite an unreadable ledger: ${String(error)}`]);
  }

  const previousEntries = new Map(
    (previousLedger?.entries ?? []).map((entry) => [entry.upstreamSha, entry] as const),
  );
  const nextManifestShas = new Set(commits.map((commit) => commit.sha));
  const previousOlderShas = new Set(
    (previousLedger?.olderBacklog ?? []).flatMap((category) => category.upstreamShas ?? []),
  );
  const rolledOutEntries: OlderBacklogCategory[] = (previousLedger?.entries ?? [])
    .filter(
      (entry) =>
        !nextManifestShas.has(entry.upstreamSha) && !previousOlderShas.has(entry.upstreamSha),
    )
    .map((entry) => ({
      category: `historical-${entry.upstreamSha.slice(0, 12)}`,
      selection: `Exact upstream commit: ${entry.subject}`,
      disposition: entry.disposition,
      reason: entry.reason ?? `Port disposition retained when the commit left the frozen window.`,
      upstreamShas: [entry.upstreamSha],
      ...(entry.f5Shas ? { f5Shas: entry.f5Shas } : {}),
      ...(entry.evidence ? { evidence: entry.evidence } : {}),
    }));

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
  const defaultOlderBacklog: OlderBacklogCategory[] = [
    {
      category: "pre-schema-ledger",
      selection: "Upstream SHAs tracked before the frozen 500-commit window",
      disposition: "deferred",
      reason:
        "Historical claims are retained for provenance but require f5 commit and file:line evidence before they can be promoted to completed dispositions.",
      ...(legacyShas.length > 0 ? { upstreamShas: legacyShas.sort() } : {}),
    },
    {
      category: "mobile",
      selection: "Older feat/fix/mobile commits after 86c94b48 and before the frozen window",
      disposition: "not-applicable",
      reason: "f5 has no mobile application product line.",
    },
    {
      category: "connect-relay-hosted",
      selection: "Older Connect, relay, pairing, and hosted-frontend commits",
      disposition: "not-applicable",
      reason: "f5 uses its existing remote-access model and has no managed relay product line.",
    },
  ];
  const previousCategories = new Set(
    (previousLedger?.olderBacklog ?? []).map((category) => category.category),
  );
  const ledger: Ledger = {
    schemaVersion: 3,
    manifest: "scripts/upstream-ports.manifest.json",
    manifestSha256: sha256(manifestText),
    entries: commits.map((commit) => {
      const previous = previousEntries.get(commit.sha);
      return previous === undefined
        ? classifyCommit(commit)
        : { ...previous, subject: commit.subject };
    }),
    olderBacklog: [
      ...(previousLedger?.olderBacklog ?? []),
      ...rolledOutEntries,
      ...defaultOlderBacklog.filter((category) => !previousCategories.has(category.category)),
    ],
  };

  writeFileSync(MANIFEST_PATH, manifestText);
  writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`);
  console.log(`Frozen ${commits.length} commits at ${headSha}.`);
}

function validate(): void {
  const errors: string[] = [];
  let manifest: Manifest;
  let ledger: Ledger;
  try {
    manifest = readManifest(MANIFEST_PATH);
    ledger = readLedger(LEDGER_PATH);
  } catch (error) {
    fail([String(error)]);
  }

  if (manifest.schemaVersion !== 1) errors.push("unsupported manifest schemaVersion");
  if (ledger.schemaVersion !== 3) errors.push("unsupported ledger schemaVersion");
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
  for (const entry of ledger.entries) {
    if (!manifestShas.has(entry.upstreamSha)) {
      errors.push(`ledger SHA ${entry.upstreamSha} is not in the frozen manifest`);
    }
    if (ledgerShas.has(entry.upstreamSha)) errors.push(`duplicate ledger SHA ${entry.upstreamSha}`);
    ledgerShas.add(entry.upstreamSha);
    if (!DISPOSITIONS.has(entry.disposition)) {
      errors.push(`ledger SHA ${entry.upstreamSha} has invalid disposition ${entry.disposition}`);
      continue;
    }
    const completed = entry.disposition === "ported" || entry.disposition === "already-present";
    if (completed && (!entry.f5Shas || entry.f5Shas.length === 0)) {
      errors.push(`completed ledger SHA ${entry.upstreamSha} has no f5 SHA`);
    }
    if (!completed && !assertNonEmpty(entry.reason)) {
      errors.push(`skipped/deferred ledger SHA ${entry.upstreamSha} has no concrete reason`);
    }
    if (
      entry.disposition === "already-present" &&
      (!entry.evidence || entry.evidence.length === 0)
    ) {
      errors.push(`already-present ledger SHA ${entry.upstreamSha} has no file:line evidence`);
    }
    if (entry.disposition !== "already-present" && entry.evidence && entry.evidence.length > 0) {
      errors.push(
        `ledger SHA ${entry.upstreamSha} has evidence outside already-present disposition`,
      );
    }
    for (const f5Sha of entry.f5Shas ?? []) {
      if (!SHA_PATTERN.test(f5Sha)) {
        errors.push(`ledger SHA ${entry.upstreamSha} has invalid f5 SHA ${f5Sha}`);
        continue;
      }
      try {
        git(["cat-file", "-e", `${f5Sha}^{commit}`]);
      } catch {
        errors.push(`ledger SHA ${entry.upstreamSha} references non-resolving f5 SHA ${f5Sha}`);
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
    if (!DISPOSITIONS.has(category.disposition)) {
      errors.push(`older-backlog category ${category.category} has an invalid disposition`);
      continue;
    }
    const completed =
      category.disposition === "ported" || category.disposition === "already-present";
    if (completed && (!category.upstreamShas || category.upstreamShas.length === 0)) {
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
    for (const sha of category.upstreamShas ?? []) {
      if (!SHA_PATTERN.test(sha)) errors.push(`older-backlog category has invalid SHA ${sha}`);
      if (manifestShas.has(sha))
        errors.push(`older-backlog SHA ${sha} overlaps the frozen manifest`);
      if (olderShas.has(sha)) errors.push(`duplicate older-backlog SHA ${sha}`);
      olderShas.add(sha);
    }
    for (const f5Sha of category.f5Shas ?? []) {
      if (!SHA_PATTERN.test(f5Sha)) {
        errors.push(`older-backlog category ${category.category} has invalid f5 SHA ${f5Sha}`);
        continue;
      }
      try {
        git(["cat-file", "-e", `${f5Sha}^{commit}`]);
      } catch {
        errors.push(
          `older-backlog category ${category.category} references non-resolving f5 SHA ${f5Sha}`,
        );
      }
    }
  }

  if (!process.env.CI) {
    try {
      verifyAuthoritativeRemote();
      git(["merge-base", "--is-ancestor", manifest.selection.headSha, "upstream/main"]);
      const actual = frozenCommits(manifest.selection.headSha);
      if (JSON.stringify(actual) !== JSON.stringify(manifest.commits)) {
        errors.push("checked-in manifest differs from the frozen upstream commit set");
      }
      for (const sha of olderShas) {
        git(["cat-file", "-e", `${sha}^{commit}`]);
      }
    } catch (error) {
      errors.push(`could not resolve frozen upstream history locally: ${String(error)}`);
    }
  } else {
    console.warn(
      "upstream ports: CI validates checked-in data only; upstream SHA resolution skipped",
    );
  }

  if (errors.length > 0) fail(errors);
  console.log(
    `Upstream port ledger valid: ${ledger.entries.length} frozen commits, ${ledger.olderBacklog.length} older categories.`,
  );
}

if (process.argv.includes("--refresh")) refresh();
else validate();
