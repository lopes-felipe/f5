/**
 * One-time, resumable move from the schema-6 `scripts/upstream-ports.json` to
 * the v7 layout under `upstream/`. Success is declared only after the whole
 * destination verifies. Delete this script once the Upstream page ships.
 *
 *   bun scripts/migrate-upstream-ledger-v7.ts
 */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { parseCheckedInProjectFile } from "@t3tools/shared/checkedInProjectFile";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import {
  ARCHIVE_PATH,
  canonicalJson,
  LEDGER_STATE_DIRS,
  parseLedgerFiles,
  parseRules,
  POLICY_PATH,
  RULES_PATH,
  validateLedger,
  validatePolicy,
  type RunGitSync,
} from "@t3tools/shared/upstreamPorts";
import {
  archiveContext,
  parseArchive,
  pendingArchiveShas,
  validateArchive,
  validateArchiveProvenance,
} from "@t3tools/shared/upstreamPortsArchive";
import { Schema } from "effect";

import { normalizeRepositoryUrl } from "./check-upstream-ports.ts";

export const OLD_LEDGER_PATH = "scripts/upstream-ports.json";
export const LEDGER_DIR = "upstream";
export const UPSTREAM_BLOCK = {
  repository: "https://github.com/pingdotgg/t3code.git",
  remote: "upstream",
  branch: "main",
} as const;

export const SEED_RULES = {
  schemaVersion: 1,
  reasonKeys: [
    "mobile",
    "relay-cloud",
    "multi-environment",
    "devices",
    "marketing",
    "release-ci",
    "maintenance",
    "reverted",
    "declined-by-policy",
  ],
  reasonLabels: {
    mobile: "Mobile app only",
    "relay-cloud": "Relay or cloud service only",
    "multi-environment": "Multi-environment only",
    devices: "Devices and simulators only",
    marketing: "Marketing site only",
    "release-ci": "Upstream release or CI only",
    maintenance: "No user-visible behavior change",
    reverted: "Reverted upstream",
    "declined-by-policy": "Declined by f5 product policy",
  },
  upstreamOnlySubsystems: [
    "auth-scopes",
    "tiptap-composer",
    "orchestration-v2",
    "lineage-delegation",
    "context-handoff",
    "scheduled-tasks",
    "source-control-gitcafe",
    "analytics-feedback",
    "t3-connect",
  ],
  ignoredPathPrefixes: [".repos/"],
  autoSkip: [
    { reasonKey: "mobile", pathPrefixes: ["apps/mobile/"] },
    { reasonKey: "marketing", pathPrefixes: ["apps/marketing/"] },
    { reasonKey: "release-ci", pathPrefixes: [".github/"] },
    { reasonKey: "maintenance", pathPrefixes: ["docs/"], pathSuffixes: [".md"] },
    {
      reasonKey: "maintenance",
      pathSuffixes: [".test.ts", ".test.tsx", ".browser.tsx", ".spec.ts"],
    },
  ],
  autoSkipConfidence: 0.85,
};

export const SEED_POLICY = `# Upstream porting policy

This file is read verbatim by F5's upstream triage and port prompts (16 KiB limit).
Edit it in a normal pull request. When you answer an open triage question, record the answer here.

## Port when

- The change is a user-visible capability or UX improvement in a surface f5 has: threads, timeline and composer; panels; PR hub and forges; providers (Codex, Claude, Cursor, OpenCode, Grok, Antigravity, Muse, Pi); terminal; git, worktrees and checkpoints; preview browser; usage; settings; desktop.
- It fixes a bug whose symptom can occur in f5's equivalent subsystem. Judge by behavior, not by path.
- It is a measurable performance, reliability or observability improvement.

## Skip

Use the reason keys in \`rules.json\`.

- \`relay-cloud\` covers T3 Connect, relay, tunnels, Clerk, outside-agent OAuth, pairing grants and webhooks.
- \`maintenance\` covers chore, test, ci, docs and style changes, React Compiler adoption, and refactors with no behavior change.
- \`upstream-only:<slug>\` covers upstream subsystems f5 does not have (listed in \`rules.json\`).

## Declined (\`declined-by-policy\`)

- Working sidebar section (f5 keeps \`SidebarAttentionSection\`)
- Secret-request card
- macOS default-browser registration
- \`t3/\` branch prefix (f5 keeps \`t3code/\`)
- Tool calls without cards, and tool-row redesigns
- Morph icons
- Compact-before-send, and automatic compaction before resume
- Mobile-app nag
- Anonymous-usage note
- Automatic file-link repair
- Trailing toast icons

## Porting defaults

- Final upstream behavior wins; never restore reverted behavior.
- New automatic behavior ships off.
- Keep f5 defaults for \`autoResumeUsageLimitedThreads\`, \`resumeActiveTurnsAfterRestart\`, \`autoPullDefaultBranch\` and \`storageCleanup.enabled\`.
- Keep f5's Agents panel; port only fixes that improve it.
- Reimplement inside f5's layers. Upstream \`orchestration-v2\`, \`packages/provider-*\`, \`client-runtime\` and \`source-control-*\` do not exist here.

## Watch

Valuable changes that depend on an unfinished upstream series. Revisit after 30 days.

## Open questions

When a choice depends on an f5 product preference this policy does not cover, ask rather than guess. Once a question is answered, add the answer to this file.
`;

export type MigrationStep = "archive" | "seeds" | "verified" | "old-removed";

export interface MigrationOptions {
  readonly root: string;
  readonly runGit: RunGitSync;
  /**
   * The integration branch. When it still holds the schema-6 ledger, an
   * existing archive must match it byte for byte (default `origin/main`).
   */
  readonly mainRef?: string;
  /** Test hook: called after each durable step. */
  readonly afterStep?: (step: MigrationStep) => void;
}

export interface MigrationResult {
  readonly outcome: "migrated" | "already-migrated";
  readonly legacyRemaining: number;
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Temp file, fsync, rename, directory fsync. */
export function writeFileAtomic(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(temp, "wx", 0o644);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
  syncDirectory(path.dirname(file));
}

const decodeLenient = Schema.decodeUnknownSync(fromLenientJson(Schema.Unknown));

function mergedProjectFile(existing: string | null): string | null {
  if (existing !== null && parseCheckedInProjectFile(existing).upstream !== null) return null;
  const value = existing === null ? {} : decodeLenient(existing);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("f5.json is not a JSON object; fix it before migrating");
  return `${JSON.stringify({ ...value, upstream: UPSTREAM_BLOCK }, null, 2)}\n`;
}

function verifyRemote(runGit: RunGitSync): string {
  let url: string;
  try {
    url = runGit(["remote", "get-url", UPSTREAM_BLOCK.remote]);
  } catch {
    throw new Error(
      `the ${UPSTREAM_BLOCK.remote} remote is required; add it with: git remote add ${UPSTREAM_BLOCK.remote} ${UPSTREAM_BLOCK.repository} && git remote set-url --push ${UPSTREAM_BLOCK.remote} DISABLED`,
    );
  }
  if (normalizeRepositoryUrl(url) !== normalizeRepositoryUrl(UPSTREAM_BLOCK.repository))
    throw new Error(`the ${UPSTREAM_BLOCK.remote} remote points at ${url}`);
  const ref = `refs/remotes/${UPSTREAM_BLOCK.remote}/${UPSTREAM_BLOCK.branch}`;
  runGit(["rev-parse", "--verify", "--quiet", ref]);
  return ref;
}

function validateArchiveText(text: string, runGit: RunGitSync, remoteRef: string): number {
  const archive = parseArchive(text);
  const pending = pendingArchiveShas(archive);
  if (pending.length)
    throw new Error(
      `the schema-6 ledger has pending records; review them first: ${pending.join(", ")}`,
    );
  const errors = [
    ...validateArchive(archive),
    ...validateArchiveProvenance(archive, runGit, remoteRef),
  ];
  if (errors.length) throw new Error(errors.join("\n"));
  return archive.entries.filter((entry) => entry.disposition === "deferred").length;
}

function verifyDestination(root: string, runGit: RunGitSync, remoteRef: string): number {
  const ledgerRoot = path.join(root, LEDGER_DIR);
  const legacyRemaining = validateArchiveText(
    readFileSync(path.join(ledgerRoot, ARCHIVE_PATH), "utf8"),
    runGit,
    remoteRef,
  );
  const archive = archiveContext(
    parseArchive(readFileSync(path.join(ledgerRoot, ARCHIVE_PATH), "utf8")),
  );
  const rules = parseRules(readFileSync(path.join(ledgerRoot, RULES_PATH), "utf8"));
  const policyErrors = validatePolicy(readFileSync(path.join(ledgerRoot, POLICY_PATH), "utf8"));
  const project = parseCheckedInProjectFile(readFileSync(path.join(root, "f5.json"), "utf8"));
  const files = new Map<string, string>();
  for (const dir of LEDGER_STATE_DIRS) {
    const absolute = path.join(ledgerRoot, dir);
    if (!existsSync(absolute)) continue;
    for (const name of readdirSync(absolute))
      files.set(`${dir}/${name}`, readFileSync(path.join(absolute, name), "utf8"));
  }
  const parsed = parseLedgerFiles(files);
  const errors = [
    ...rules.errors,
    ...policyErrors,
    ...(project.upstream === null ? ["f5.json has no valid upstream block"] : []),
    ...parsed.errors,
    ...validateLedger(parsed.ledger, { rules: rules.rules, archive }),
  ];
  if (errors.length) throw new Error(`destination verification failed:\n${errors.join("\n")}`);
  return legacyRemaining;
}

export function migrateUpstreamLedger(options: MigrationOptions): MigrationResult {
  const { root, runGit } = options;
  const remoteRef = verifyRemote(runGit);
  const oldPath = path.join(root, OLD_LEDGER_PATH);
  const archivePath = path.join(root, LEDGER_DIR, ARCHIVE_PATH);
  const hasOld = existsSync(oldPath);
  const hasArchive = existsSync(archivePath);
  if (!hasOld && !hasArchive)
    throw new Error(`neither ${OLD_LEDGER_PATH} nor ${LEDGER_DIR}/${ARCHIVE_PATH} exists`);

  if (hasOld) {
    const oldText = readFileSync(oldPath, "utf8");
    if (hasArchive) {
      if (readFileSync(archivePath, "utf8") !== oldText)
        throw new Error(
          `conflicting archive: ${LEDGER_DIR}/${ARCHIVE_PATH} differs from ${OLD_LEDGER_PATH}`,
        );
    } else {
      validateArchiveText(oldText, runGit, remoteRef);
      writeFileAtomic(archivePath, oldText);
      if (readFileSync(archivePath, "utf8") !== oldText)
        throw new Error("archive bytes differ from the schema-6 ledger after writing");
    }
    options.afterStep?.("archive");
  } else {
    // Taking the deletion in a modify/delete conflict leaves an older archive
    // that would verify and then become immutable; compare it with main's ledger.
    const mainRef = options.mainRef ?? "origin/main";
    let mainBlob: string | null = null;
    try {
      mainBlob = runGit(["rev-parse", "--verify", "--quiet", `${mainRef}:${OLD_LEDGER_PATH}`]);
    } catch {
      // Main no longer has the schema-6 ledger.
    }
    if (mainBlob !== null && runGit(["hash-object", "--no-filters", archivePath]) !== mainBlob)
      throw new Error(
        `stale archive: ${LEDGER_DIR}/${ARCHIVE_PATH} differs from ${mainRef}:${OLD_LEDGER_PATH}. Restore ${OLD_LEDGER_PATH} from ${mainRef}, git rm ${LEDGER_DIR}/${ARCHIVE_PATH}, and run the migration again.`,
      );
  }

  const seeds: Array<[string, string | null]> = [
    [path.join(root, LEDGER_DIR, RULES_PATH), canonicalJson(SEED_RULES)],
    [path.join(root, LEDGER_DIR, POLICY_PATH), SEED_POLICY],
  ];
  for (const [file, contents] of seeds)
    if (!existsSync(file) && contents !== null) writeFileAtomic(file, contents);
  const projectFile = path.join(root, "f5.json");
  const merged = mergedProjectFile(
    existsSync(projectFile) ? readFileSync(projectFile, "utf8") : null,
  );
  if (merged !== null) writeFileAtomic(projectFile, merged);
  options.afterStep?.("seeds");

  const legacyRemaining = verifyDestination(root, runGit, remoteRef);
  options.afterStep?.("verified");

  if (hasOld) {
    unlinkSync(oldPath);
    syncDirectory(path.dirname(oldPath));
    options.afterStep?.("old-removed");
    return { outcome: "migrated", legacyRemaining };
  }
  return { outcome: "already-migrated", legacyRemaining };
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
    const result = migrateUpstreamLedger({
      root,
      runGit,
      ...(process.env.F5_UPSTREAM_MAIN_REF ? { mainRef: process.env.F5_UPSTREAM_MAIN_REF } : {}),
    });
    console.log(
      `${result.outcome === "migrated" ? "Migrated" : "Already migrated; verified"} the upstream ledger to ${LEDGER_DIR}/ (${result.legacyRemaining} archive deferred records remain for legacy triage).`,
    );
  } catch (error) {
    console.error(`upstream migration: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
