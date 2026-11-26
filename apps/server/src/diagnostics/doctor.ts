import * as FS from "node:fs/promises";
import * as FSync from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import type {
  DoctorCheck,
  DoctorCheckStatus,
  DoctorProviderSummary,
  ServerDoctorReport,
  ServerHealth,
  ServerProvider,
} from "@t3tools/contracts";

import { version as SERVER_APP_VERSION } from "../../package.json" with { type: "json" };
import { isLoopbackHost } from "../networkHost.ts";
import { databaseDamageMarkerPath, getDatabaseDamage } from "../persistence/databaseHealth.ts";
import { openRuntimeSqliteDatabase } from "../persistence/runtimeSqlite.ts";
import {
  DEFAULT_WORKTREES_SETTINGS,
  managedWorktreesDirectories,
} from "../worktreesDirectoryPaths.ts";

const WAL_WARN_BYTES = 128 * 1024 * 1024;
const DISK_WARN_BYTES = 2 * 1024 * 1024 * 1024;
const DISK_ERROR_BYTES = 512 * 1024 * 1024;
const WORKTREE_COUNT_WARN = 50;

const LEGACY_ENV_KEYS = [
  "T3CODE_MODE",
  "T3CODE_PORT",
  "T3CODE_HOST",
  "T3CODE_HOME",
  "T3CODE_STATE_DIR",
  "T3CODE_NO_BROWSER",
  "T3CODE_AUTH_TOKEN",
  "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
  "T3CODE_LOG_WS_EVENTS",
  "T3CODE_OBSERVABILITY_ENABLED",
  "T3CODE_LOG_THREAD_OPEN_TIMINGS",
  "T3CODE_LOG_PROJECTION_TIMINGS",
  "T3CODE_WEB_SOURCEMAP",
] as const;

interface BuiltInCliProbe {
  readonly id: string;
  readonly label: string;
  readonly binaries: ReadonlyArray<string>;
}

const BUILT_IN_PROVIDER_CLI_PROBES: ReadonlyArray<BuiltInCliProbe> = [
  { id: "codex", label: "Codex", binaries: ["codex"] },
  { id: "claude", label: "Claude Code", binaries: ["claude"] },
  { id: "cursor", label: "Cursor", binaries: ["cursor-agent", "agent"] },
  { id: "opencode", label: "OpenCode", binaries: ["opencode"] },
  { id: "grok", label: "Grok", binaries: ["grok"] },
  { id: "antigravity", label: "Antigravity", binaries: ["antigravity", "agy"] },
  { id: "muse", label: "Muse Code", binaries: ["muse"] },
  { id: "pi", label: "Pi", binaries: ["pi"] },
];

export interface SqliteInspectionSnapshot {
  /**
   * Lines returned by `PRAGMA quick_check(5)`, or `null` when intentionally
   * skipped on a live server connection to avoid blocking the main event loop.
   */
  readonly quickCheck: ReadonlyArray<string> | null;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly freelistCount: number;
  readonly autoVacuum: number;
  readonly journalMode: string;
  readonly migrationCount: number | null;
  readonly latestMigrationId: number | null;
}

export type SqliteInspectionResult =
  | { readonly kind: "ok"; readonly snapshot: SqliteInspectionSnapshot }
  | { readonly kind: "corrupt"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string };

export interface RawSqliteInspectionRows {
  readonly quickRows?: ReadonlyArray<{ readonly quick_check?: unknown }> | null;
  readonly pageSizeRow?: { readonly page_size?: unknown } | null | undefined;
  readonly pageCountRow?: { readonly page_count?: unknown } | null | undefined;
  readonly freelistRow?: { readonly freelist_count?: unknown } | null | undefined;
  readonly autoVacuumRow?: { readonly auto_vacuum?: unknown } | null | undefined;
  readonly journalRow?: { readonly journal_mode?: unknown } | null | undefined;
  readonly migrationRow?:
    | { readonly count?: unknown; readonly latest?: unknown }
    | null
    | undefined;
}

/** Shared mapper used by both offline `inspectSqliteReadOnly` and live `wsServer` PRAGMA reads. */
export function buildSqliteInspectionSnapshot(
  rows: RawSqliteInspectionRows,
): SqliteInspectionSnapshot {
  const toNumber = (value: unknown): number => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const quickCheck =
    rows.quickRows === null || rows.quickRows === undefined
      ? null
      : rows.quickRows
          .map((row) => String(row.quick_check ?? ""))
          .filter((line) => line.length > 0);
  const countRaw = rows.migrationRow?.count;
  const latestRaw = rows.migrationRow?.latest;
  return {
    quickCheck,
    pageSize: toNumber(rows.pageSizeRow?.page_size),
    pageCount: toNumber(rows.pageCountRow?.page_count),
    freelistCount: toNumber(rows.freelistRow?.freelist_count),
    autoVacuum: toNumber(rows.autoVacuumRow?.auto_vacuum),
    journalMode: String(rows.journalRow?.journal_mode ?? "unknown"),
    migrationCount: typeof countRaw === "number" ? countRaw : null,
    latestMigrationId: typeof latestRaw === "number" ? latestRaw : null,
  };
}

export interface RunDoctorInput {
  readonly mode: "web" | "desktop" | "cli";
  readonly stateDir: string;
  readonly dbPath: string;
  readonly worktreesDir: string;
  /** Optional explicit list of managed worktree roots (e.g. from `ServerSettingsService`). */
  readonly worktreesDirs?: ReadonlyArray<string>;
  readonly logsDir: string;
  readonly attachmentsDir: string;
  readonly profilesRoot?: string;
  readonly profileSlug?: string;
  readonly profileName?: string;
  readonly isDefaultProfile?: boolean;
  readonly host?: string;
  readonly port?: number;
  readonly authEnabled?: boolean;
  readonly trustedProxyCount?: number;
  /** Live provider snapshots when running inside the server process. */
  readonly liveProviders?: ReadonlyArray<ServerProvider>;
  /** Optional SQLite inspector (e.g. backed by the live server SqlClient). */
  readonly inspectSqlite?: () => Promise<SqliteInspectionResult | null>;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly appVersion?: string;
}

export interface RedactedSupportBundle {
  readonly schemaVersion: 1;
  readonly exportedAt: string;
  readonly doctor: ServerDoctorReport;
  readonly serverHealth?: ServerHealth | null;
}

export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceHomePrefix(text: string, homeVariant: string, caseInsensitive: boolean): string {
  if (homeVariant.length <= 1) return text;
  // Require a path/token boundary before and after the home prefix so `/Users/al`
  // never rewrites `/Users/alice` into `~ice`.
  const pattern = new RegExp(
    `(^|[\\s"'(\`=,;:])${escapeRegExp(homeVariant)}(?=$|[\\\\/\\s"')\\]\`,;:])`,
    caseInsensitive ? "giu" : "gu",
  );
  return text.replace(pattern, "$1~");
}

/**
 * Scrubs inline URL credentials, credential query parameters, common bearer/API
 * tokens, email addresses, and user home-directory prefixes from diagnostic text.
 */
export function redactDiagnosticText(
  value: string,
  homeDir = OS.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  // 1. Inline URL credentials (`scheme://user:pass@host`)
  let result = value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/giu, "$1***@");

  // 2. Credential query parameters (`?token=...`, `&api_key=...`, etc.)
  result = result.replace(
    /([?&](?:access_token|api_key|apikey|auth|bearer|key|passwd|password|secret|sig|signature|token)=)[^&\s"'<>#]+/giu,
    "$1***",
  );

  // 3. Bearer / Authorization tokens
  result = result.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu, "$1***");

  // 4. Common provider / forge API token prefixes
  result = result.replace(
    /\b(?:sk-(?:proj-|ant-)?|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AIza)[A-Za-z0-9_-]{8,}\b/gu,
    "[REDACTED_TOKEN]",
  );

  // 5. Email addresses
  result = result.replace(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu,
    "[REDACTED_EMAIL]",
  );

  // 6. User home directory prefixes (case-insensitive on macOS and Windows)
  const trimmedHome = homeDir.replace(/[\\/]+$/u, "");
  const caseInsensitive = platform === "darwin" || platform === "win32";
  if (trimmedHome.length > 1) {
    result = replaceHomePrefix(result, trimmedHome, caseInsensitive);
    const posixHome = trimmedHome.replace(/\\/gu, "/");
    if (posixHome !== trimmedHome) {
      result = replaceHomePrefix(result, posixHome, caseInsensitive);
    }
  }

  return result;
}

async function fileSizeIfExists(filePath: string): Promise<number | null> {
  try {
    const stat = await FS.stat(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

async function countDirEntries(dirPath: string): Promise<number | null> {
  try {
    const entries = await FS.readdir(dirPath);
    return entries.length;
  } catch {
    return null;
  }
}

/**
 * Counts managed Git worktree checkouts across all managed roots.
 * Managed worktrees live two levels deep (`<root>/<repo-dir>/<worktree-dir>`).
 */
async function countManagedWorktreeCheckouts(
  roots: ReadonlyArray<string>,
): Promise<{ readonly rootsExisting: number; readonly checkoutCount: number }> {
  let rootsExisting = 0;
  let checkoutCount = 0;
  for (const root of new Set(roots)) {
    let repoEntries: ReadonlyArray<FSync.Dirent>;
    try {
      repoEntries = await FS.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    rootsExisting += 1;
    for (const repoEntry of repoEntries) {
      if (!repoEntry.isDirectory() || repoEntry.name.startsWith(".")) continue;
      const repoDir = Path.join(root, repoEntry.name);
      try {
        const worktrees = await FS.readdir(repoDir, { withFileTypes: true });
        for (const wt of worktrees) {
          if (wt.isDirectory() && !wt.name.startsWith(".")) {
            checkoutCount += 1;
          }
        }
      } catch {
        // Repo directory disappeared or is unreadable; skip.
      }
    }
  }
  return { rootsExisting, checkoutCount };
}

async function resolveOfflineWorktreesDirs(
  stateDir: string,
  defaultDir: string,
): Promise<string[]> {
  try {
    const raw = await FS.readFile(Path.join(stateDir, "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const worktreesDirectory =
      typeof parsed.worktreesDirectory === "string" ? parsed.worktreesDirectory : "";
    const previousWorktreesDirectories = Array.isArray(parsed.previousWorktreesDirectories)
      ? parsed.previousWorktreesDirectories.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    return managedWorktreesDirectories(
      { worktreesDirectory, previousWorktreesDirectories },
      defaultDir,
    );
  } catch {
    return managedWorktreesDirectories(DEFAULT_WORKTREES_SETTINGS, defaultDir);
  }
}

export async function findExecutableOnPath(
  binaryName: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const pathValue = env.PATH ?? env.Path ?? "";
  if (!pathValue) return null;
  const dirs = pathValue
    .split(platform === "win32" ? ";" : ":")
    .filter((entry) => entry.length > 0);
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((ext) => ext.length > 0)
      : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = Path.join(
        dir,
        platform === "win32" && !binaryName.includes(".") ? `${binaryName}${ext}` : binaryName,
      );
      try {
        await FS.access(
          candidate,
          platform === "win32" ? FSync.constants.F_OK : FSync.constants.X_OK,
        );
        const stat = await FS.stat(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        // Not executable at this PATH entry.
      }
    }
  }
  return null;
}

function isSqliteCorruptionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "errcode" in error
      ? String((error as { errcode?: unknown }).errcode ?? "")
      : typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
  const combined = `${code} ${message}`;
  return /SQLITE_NOTADB|SQLITE_CORRUPT|file is not a database|database disk image is malformed|malformed database schema/iu.test(
    combined,
  );
}

/**
 * Opens `dbPath` strictly read-only via the active runtime's SQLite driver
 * (`bun:sqlite` under Bun, `node:sqlite` under Node) for offline CLI checks.
 * Distinguishes confirmed database corruption from runtime unavailability.
 */
export async function inspectSqliteReadOnly(
  dbPath: string,
  homeDir = OS.homedir(),
  platform: NodeJS.Platform = process.platform,
): Promise<SqliteInspectionResult | null> {
  const size = await fileSizeIfExists(dbPath);
  if (size === null) return null;

  let db: Awaited<ReturnType<typeof openRuntimeSqliteDatabase>>;
  try {
    db = await openRuntimeSqliteDatabase(dbPath, { readOnly: true });
  } catch (error) {
    const detail = redactDiagnosticText(
      error instanceof Error ? error.message : String(error),
      homeDir,
      platform,
    );
    return isSqliteCorruptionError(error)
      ? { kind: "corrupt", detail }
      : { kind: "unavailable", detail };
  }

  try {
    const quickRows = db.prepare("PRAGMA quick_check(5)").all() as ReadonlyArray<{
      readonly quick_check?: unknown;
    }>;
    const pageSizeRow = db.prepare("PRAGMA page_size").get() as
      | { readonly page_size?: unknown }
      | null
      | undefined;
    const pageCountRow = db.prepare("PRAGMA page_count").get() as
      | { readonly page_count?: unknown }
      | null
      | undefined;
    const freelistRow = db.prepare("PRAGMA freelist_count").get() as
      | { readonly freelist_count?: unknown }
      | null
      | undefined;
    const autoVacuumRow = db.prepare("PRAGMA auto_vacuum").get() as
      | { readonly auto_vacuum?: unknown }
      | null
      | undefined;
    const journalRow = db.prepare("PRAGMA journal_mode").get() as
      | { readonly journal_mode?: unknown }
      | null
      | undefined;
    let migrationRow: { readonly count?: unknown; readonly latest?: unknown } | null | undefined;
    try {
      migrationRow = db
        .prepare("SELECT COUNT(*) AS count, MAX(migration_id) AS latest FROM effect_sql_migrations")
        .get() as { readonly count?: unknown; readonly latest?: unknown } | null | undefined;
    } catch {
      // Fresh or uninitialized DB without migrations table.
    }
    return {
      kind: "ok",
      snapshot: buildSqliteInspectionSnapshot({
        quickRows,
        pageSizeRow,
        pageCountRow,
        freelistRow,
        autoVacuumRow,
        journalRow,
        migrationRow,
      }),
    };
  } catch (error) {
    const detail = redactDiagnosticText(
      error instanceof Error ? error.message : String(error),
      homeDir,
      platform,
    );
    return isSqliteCorruptionError(error)
      ? { kind: "corrupt", detail }
      : { kind: "unavailable", detail };
  } finally {
    db.close();
  }
}

function summarizeLiveProviders(
  providers: ReadonlyArray<ServerProvider>,
  homeDir: string,
  platform: NodeJS.Platform,
): ReadonlyArray<DoctorProviderSummary> {
  return providers.map((provider) => {
    const label = provider.displayName ?? provider.driver;
    const status: DoctorProviderSummary["status"] = !provider.enabled
      ? "disabled"
      : !provider.installed
        ? "missing"
        : provider.status === "ready"
          ? "ready"
          : provider.status === "warning"
            ? "warning"
            : "error";
    const summaryParts: string[] = [];
    if (!provider.enabled) {
      summaryParts.push("Disabled");
    } else if (!provider.installed) {
      summaryParts.push("CLI not installed");
    } else {
      summaryParts.push(
        provider.status === "ready" ? "Ready" : provider.status === "warning" ? "Warning" : "Error",
      );
      if (provider.auth.status === "authenticated") summaryParts.push("authenticated");
      else if (provider.auth.status === "unauthenticated") summaryParts.push("not signed in");
    }
    if (provider.message) {
      summaryParts.push(redactDiagnosticText(provider.message, homeDir, platform));
    }
    return {
      id: provider.instanceId,
      label,
      status,
      version: provider.version ?? null,
      summary: summaryParts.join(" · "),
    };
  });
}

async function probeOfflineProviders(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDir: string,
): Promise<ReadonlyArray<DoctorProviderSummary>> {
  return Promise.all(
    BUILT_IN_PROVIDER_CLI_PROBES.map(async (probe) => {
      for (const binary of probe.binaries) {
        const resolved = await findExecutableOnPath(binary, env, platform);
        if (resolved) {
          return {
            id: probe.id,
            label: probe.label,
            status: "ready" as const,
            version: null,
            summary: `Found at ${redactDiagnosticText(resolved, homeDir, platform)}`,
          };
        }
      }
      return {
        id: probe.id,
        label: probe.label,
        status: "missing" as const,
        version: null,
        summary: `Not found on PATH (${probe.binaries.join(" / ")})`,
      };
    }),
  );
}

function computeOverallStatus(checks: ReadonlyArray<DoctorCheck>): DoctorCheckStatus {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "ok";
}

export async function runDoctorDiagnostics(input: RunDoctorInput): Promise<ServerDoctorReport> {
  const env = input.env ?? process.env;
  const homeDir = input.homeDir ?? OS.homedir();
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const now = input.now ?? (() => new Date());
  const redact = (value: string) => redactDiagnosticText(value, homeDir, platform);
  const checks: DoctorCheck[] = [];

  // 1. Environment & toolchain checks
  const legacyVarsPresent = LEGACY_ENV_KEYS.filter((key) => {
    const val = env[key];
    return typeof val === "string" && val.trim().length > 0;
  });
  if (legacyVarsPresent.length > 0) {
    checks.push({
      id: "env.legacy-vars",
      category: "environment",
      title: "Legacy T3CODE_* environment variables",
      status: "warn",
      summary: `${legacyVarsPresent.length} legacy variable${legacyVarsPresent.length === 1 ? "" : "s"} set: ${legacyVarsPresent.join(", ")}.`,
      hint: "Rename them to their F5_* equivalents (see docs/environment.md); legacy aliases remain supported for now.",
    });
  } else {
    checks.push({
      id: "env.legacy-vars",
      category: "environment",
      title: "Environment variables",
      status: "ok",
      summary: "No deprecated T3CODE_* environment variables detected.",
    });
  }

  const [gitPath, ghPath] = await Promise.all([
    findExecutableOnPath("git", env, platform),
    findExecutableOnPath("gh", env, platform),
  ]);
  checks.push(
    gitPath
      ? {
          id: "env.git",
          category: "environment",
          title: "Git CLI",
          status: "ok",
          summary: `Found at ${redact(gitPath)}.`,
        }
      : {
          id: "env.git",
          category: "environment",
          title: "Git CLI",
          status: "error",
          summary: "git was not found on PATH.",
          hint: "Install Git and ensure it is available on PATH; worktrees, diffs, and checkpoints require git.",
        },
  );
  checks.push(
    ghPath
      ? {
          id: "env.gh",
          category: "environment",
          title: "GitHub CLI (gh)",
          status: "ok",
          summary: `Found at ${redact(ghPath)}.`,
        }
      : {
          id: "env.gh",
          category: "environment",
          title: "GitHub CLI (gh)",
          status: "warn",
          summary: "gh was not found on PATH (optional).",
          hint: "Install GitHub CLI if you want gh-backed PR creation and authentication import.",
        },
  );

  if (input.host !== undefined) {
    const loopback = isLoopbackHost(input.host);
    checks.push({
      id: "env.network",
      category: "environment",
      title: "Network & remote auth",
      status: !loopback && !input.authEnabled ? "error" : "ok",
      summary: loopback
        ? `Loopback binding (${input.host}:${input.port ?? 0}), auth ${input.authEnabled ? "enabled" : "local-only"}.`
        : `Remote binding (${input.host}:${input.port ?? 0}), auth ${input.authEnabled ? "enabled" : "MISSING"}, ${input.trustedProxyCount ?? 0} trusted prox${(input.trustedProxyCount ?? 0) === 1 ? "y" : "ies"}.`,
      ...(!loopback && !input.authEnabled
        ? { hint: "Set F5_AUTH_TOKEN (or --auth-token) whenever binding outside loopback." }
        : {}),
    });
  }

  // 2. Database integrity, WAL size, migrations & damage markers
  const [dbSize, walSize, damageMarkerSize, recoveryCount] = await Promise.all([
    fileSizeIfExists(input.dbPath),
    fileSizeIfExists(`${input.dbPath}-wal`),
    fileSizeIfExists(databaseDamageMarkerPath(input.dbPath)),
    countDirEntries(Path.join(input.stateDir, "recovery")),
  ]);
  const liveDamage = getDatabaseDamage();

  if (liveDamage !== null || damageMarkerSize !== null) {
    checks.push({
      id: "db.damage",
      category: "database",
      title: "SQLite corruption marker",
      status: "error",
      summary: "Database damage marker is present; background compaction and cleanup are paused.",
      detail: liveDamage
        ? redact(liveDamage.message)
        : `Marker found at ${redact(databaseDamageMarkerPath(input.dbPath))}.`,
      hint: "Restore from a recent backup in Settings → Storage or inspect recovery snapshots before restarting.",
    });
  }

  const sqliteResult =
    dbSize !== null || input.inspectSqlite !== undefined
      ? input.inspectSqlite
        ? await input.inspectSqlite()
        : await inspectSqliteReadOnly(input.dbPath, homeDir, platform)
      : null;

  if (dbSize === null && !sqliteResult) {
    checks.push({
      id: "db.file",
      category: "database",
      title: "SQLite database",
      status: "warn",
      summary: `Database file not yet created at ${redact(input.dbPath)}.`,
      hint: "Start F5 once to initialize this profile's SQLite database.",
    });
  } else {
    if (!sqliteResult || sqliteResult.kind === "unavailable") {
      checks.push({
        id: "db.integrity",
        category: "database",
        title: "SQLite integrity",
        status: "warn",
        summary: `Database exists (${formatBytesCompact(dbSize ?? 0)}), but read-only SQLite inspection could not run in this runtime.`,
        ...(sqliteResult?.kind === "unavailable" && sqliteResult.detail
          ? { detail: redact(sqliteResult.detail) }
          : {}),
      });
    } else if (sqliteResult.kind === "corrupt") {
      checks.push({
        id: "db.integrity",
        category: "database",
        title: "SQLite integrity & schema",
        status: "error",
        summary: `SQLite reported database corruption (${formatBytesCompact(dbSize ?? 0)}).`,
        detail: redact(sqliteResult.detail),
        hint: "Restore from a recent backup in Settings → Storage or run database recovery before continuing.",
      });
    } else {
      const sqlite = sqliteResult.snapshot;
      const liveBytes = Math.max(0, sqlite.pageCount - sqlite.freelistCount) * sqlite.pageSize;
      const freeBytes = sqlite.freelistCount * sqlite.pageSize;
      const migrationSummary =
        sqlite.migrationCount !== null
          ? `${sqlite.migrationCount} migrations applied${sqlite.latestMigrationId !== null ? ` (latest #${sqlite.latestMigrationId})` : ""}`
          : "migration table unavailable";
      const sizeLabel = dbSize !== null ? formatBytesCompact(dbSize) : "in-memory";

      if (sqlite.quickCheck === null) {
        checks.push({
          id: "db.integrity",
          category: "database",
          title: "SQLite status & schema",
          status: "ok",
          summary: `Live metadata OK · ${sizeLabel} (${formatBytesCompact(liveBytes)} live, ${formatBytesCompact(freeBytes)} free) · ${migrationSummary}.`,
          detail: `journal_mode=${sqlite.journalMode}, auto_vacuum=${sqlite.autoVacuum}`,
          hint: "Run `f5 doctor` offline from the CLI for a full PRAGMA quick_check page scan without blocking active sessions.",
        });
      } else {
        const quickOk = sqlite.quickCheck.length === 1 && sqlite.quickCheck[0] === "ok";
        checks.push({
          id: "db.integrity",
          category: "database",
          title: "SQLite integrity & schema",
          status: quickOk ? "ok" : "error",
          summary: quickOk
            ? `quick_check OK · ${sizeLabel} (${formatBytesCompact(liveBytes)} live, ${formatBytesCompact(freeBytes)} free) · ${migrationSummary}.`
            : `quick_check reported issues: ${redact(sqlite.quickCheck.join("; "))}`,
          detail: `journal_mode=${sqlite.journalMode}, auto_vacuum=${sqlite.autoVacuum}`,
          ...(!quickOk
            ? { hint: "Export a backup or run database recovery before continuing." }
            : {}),
        });
      }
    }

    if (walSize !== null && walSize > 0) {
      checks.push({
        id: "db.wal",
        category: "database",
        title: "SQLite WAL file",
        status: walSize >= WAL_WARN_BYTES ? "warn" : "ok",
        summary: `WAL size is ${formatBytesCompact(walSize)}.`,
        ...(walSize >= WAL_WARN_BYTES
          ? {
              hint: "A large WAL indicates long-running readers or pending checkpointing; compact the database in Settings → Storage.",
            }
          : {}),
      });
    }
  }

  if (recoveryCount !== null && recoveryCount > 0) {
    checks.push({
      id: "db.recovery-snapshots",
      category: "database",
      title: "Recovery snapshots",
      status: "warn",
      summary: `${recoveryCount} file${recoveryCount === 1 ? "" : "s"} present in ${redact(Path.join(input.stateDir, "recovery"))}.`,
      hint: "Review or clean up old recovery files once you confirm your database is healthy.",
    });
  }

  if (input.profilesRoot) {
    try {
      const entries = await FS.readdir(input.profilesRoot);
      const startupErrors = entries.filter((entry) => entry.startsWith("last-startup-error-"));
      if (startupErrors.length > 0) {
        checks.push({
          id: "env.startup-errors",
          category: "environment",
          title: "Recent startup errors",
          status: "warn",
          summary: `${startupErrors.length} recorded startup error file${startupErrors.length === 1 ? "" : "s"} in profiles root.`,
          hint: "Inspect the profile logs if a profile failed to boot recently.",
        });
      }
    } catch {
      // Profiles root may not exist yet.
    }
  }

  // 3. Providers
  const providers = input.liveProviders
    ? summarizeLiveProviders(input.liveProviders, homeDir, platform)
    : await probeOfflineProviders(env, platform, homeDir);

  const readyProviders = providers.filter((provider) => provider.status === "ready");
  const errorProviders = providers.filter((provider) => provider.status === "error");
  const warningProviders = providers.filter((provider) => provider.status === "warning");

  checks.push({
    id: "providers.availability",
    category: "providers",
    title: "Coding agent providers",
    status: readyProviders.length === 0 ? "warn" : errorProviders.length > 0 ? "warn" : "ok",
    summary:
      readyProviders.length > 0
        ? `${readyProviders.length} of ${providers.length} provider${providers.length === 1 ? "" : "s"} ready${errorProviders.length > 0 ? `, ${errorProviders.length} in error state` : ""}${warningProviders.length > 0 ? `, ${warningProviders.length} with warnings` : ""}.`
        : "No ready provider CLIs detected yet.",
    ...(readyProviders.length === 0
      ? {
          hint: "Install and sign in to at least one provider CLI (for example Codex, Claude Code, Cursor, or OpenCode) in Settings → Providers.",
        }
      : errorProviders.length > 0
        ? { hint: "Check Settings → Providers to re-authenticate or update failing providers." }
        : {}),
  });

  // 4. Storage & Worktrees
  try {
    const stats = await FS.statfs(input.stateDir);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    checks.push({
      id: "storage.disk-space",
      category: "storage",
      title: "Available disk space",
      status: freeBytes < DISK_ERROR_BYTES ? "error" : freeBytes < DISK_WARN_BYTES ? "warn" : "ok",
      summary: `${formatBytesCompact(freeBytes)} free on state directory volume (${redact(input.stateDir)}).`,
      ...(freeBytes < DISK_WARN_BYTES
        ? {
            hint: "Free disk space or run cleanup in Settings → Storage to avoid SQLite or worktree write failures.",
          }
        : {}),
    });
  } catch {
    checks.push({
      id: "storage.disk-space",
      category: "storage",
      title: "Available disk space",
      status: "warn",
      summary: `State directory not accessible yet (${redact(input.stateDir)}).`,
    });
  }

  const managedWorktreeRoots =
    input.worktreesDirs ?? (await resolveOfflineWorktreesDirs(input.stateDir, input.worktreesDir));
  const { rootsExisting, checkoutCount } =
    await countManagedWorktreeCheckouts(managedWorktreeRoots);
  if (rootsExisting > 0) {
    const rootList = managedWorktreeRoots.map((root) => redact(root)).join(", ");
    checks.push({
      id: "storage.worktrees",
      category: "storage",
      title: "Managed worktrees",
      status: checkoutCount > WORKTREE_COUNT_WARN ? "warn" : "ok",
      summary: `${checkoutCount} checkout${checkoutCount === 1 ? "" : "s"} across ${rootsExisting} managed root${rootsExisting === 1 ? "" : "s"} (${rootList}).`,
      ...(checkoutCount > WORKTREE_COUNT_WARN
        ? { hint: "Consider pruning idle worktrees in Settings → Storage → Automatic cleanup." }
        : {}),
    });
  } else {
    checks.push({
      id: "storage.worktrees",
      category: "storage",
      title: "Managed worktrees",
      status: "ok",
      summary: "No worktrees directory created yet.",
    });
  }

  const counts = {
    ok: checks.filter((check) => check.status === "ok").length,
    warn: checks.filter((check) => check.status === "warn").length,
    error: checks.filter((check) => check.status === "error").length,
  };

  return {
    generatedAt: now().toISOString(),
    overallStatus: computeOverallStatus(checks),
    runtime: {
      appVersion: input.appVersion ?? SERVER_APP_VERSION,
      platform,
      arch,
      runtimeKind: process.versions.bun ? "bun" : "node",
      runtimeVersion: process.versions.bun ?? process.version,
      profileSlug: input.profileSlug ?? "default",
      profileName: input.profileName ?? "Default",
      isDefaultProfile: input.isDefaultProfile ?? true,
      mode: input.mode,
    },
    counts,
    providers,
    checks,
  };
}

export function buildRedactedSupportBundle(input: {
  readonly report: ServerDoctorReport;
  readonly serverHealth?: ServerHealth | null;
  readonly exportedAt?: string;
}): RedactedSupportBundle {
  return {
    schemaVersion: 1,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    doctor: input.report,
    ...(input.serverHealth !== undefined ? { serverHealth: input.serverHealth } : {}),
  };
}

export function formatDoctorReportText(report: ServerDoctorReport): string {
  const lines: string[] = [];
  const overallLabel =
    report.overallStatus === "ok"
      ? "HEALTHY"
      : report.overallStatus === "warn"
        ? "WARNINGS"
        : "ISSUES DETECTED";

  lines.push(
    `F5 Doctor: ${overallLabel} (v${report.runtime.appVersion}, ${report.runtime.runtimeKind} ${report.runtime.runtimeVersion}, ${report.runtime.platform}/${report.runtime.arch})`,
  );
  lines.push(
    `Profile: ${report.runtime.profileName} (${report.runtime.profileSlug}) · Checks: ${report.counts.ok} ok, ${report.counts.warn} warn, ${report.counts.error} error`,
  );
  lines.push("");

  for (const check of report.checks) {
    const tag = check.status === "ok" ? "[OK]  " : check.status === "warn" ? "[WARN]" : "[ERR] ";
    lines.push(`${tag} ${check.title}: ${check.summary}`);
    if (check.detail) lines.push(`       ${check.detail}`);
    if (check.hint) lines.push(`       Hint: ${check.hint}`);
  }

  if (report.providers.length > 0) {
    lines.push("");
    lines.push("Providers:");
    for (const provider of report.providers) {
      const versionPart = provider.version ? ` (${provider.version})` : "";
      lines.push(`  - ${provider.label}${versionPart}: [${provider.status}] ${provider.summary}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
