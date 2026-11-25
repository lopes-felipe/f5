import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ServerDoctorReport, type ServerProvider } from "@t3tools/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  buildRedactedSupportBundle,
  formatDoctorReportText,
  inspectSqliteReadOnly,
  redactDiagnosticText,
  runDoctorDiagnostics,
} from "./doctor.ts";
import { customWorktreesDirectory } from "../worktreesDirectoryPaths.ts";

describe("doctor diagnostics", () => {
  it("redacts user home paths with boundary + case handling and scrubs credentials, tokens, and emails", () => {
    const redacted = redactDiagnosticText(
      "Reading /Users/alice/.f5/userdata/state.sqlite via https://alice:s3cr3t@example.com/hook?token=tok_live_123456789&api_key=key_secret_987",
      "/Users/alice",
      "darwin",
    );
    expect(redacted).toBe(
      "Reading ~/.f5/userdata/state.sqlite via https://***@example.com/hook?token=***&api_key=***",
    );
    expect(redacted).not.toContain("alice");
    expect(redacted).not.toContain("s3cr3t");
    expect(redacted).not.toContain("tok_live_123456789");
    expect(redacted).not.toContain("key_secret_987");

    // Must not partially rewrite `/Users/alice` when home is `/Users/al`
    expect(
      redactDiagnosticText("Path /Users/alice/repo and /Users/al/repo", "/Users/al", "darwin"),
    ).toBe("Path /Users/alice/repo and ~/repo");

    // Case-insensitive home matching on macOS/Windows
    expect(redactDiagnosticText("Opening /users/alice/work", "/Users/Alice", "darwin")).toBe(
      "Opening ~/work",
    );

    // Bearer, provider API keys, and emails
    const secrets = redactDiagnosticText(
      "Auth failed: Bearer eyJhbGciOiJIUzI1NiJ9.payload sk-proj-abcdef1234567890 ghp_1234567890abcdef123456 for dev@example.org",
      "/Users/dev",
      "linux",
    );
    expect(secrets).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(secrets).not.toContain("sk-proj-abcdef1234567890");
    expect(secrets).not.toContain("ghp_1234567890abcdef123456");
    expect(secrets).not.toContain("dev@example.org");
    expect(secrets).toContain("Bearer ***");
    expect(secrets).toContain("[REDACTED_TOKEN]");
    expect(secrets).toContain("[REDACTED_EMAIL]");
  });

  it("inspects a real healthy SQLite DB and classifies a corrupt non-DB file as error", async () => {
    const tempDir = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-doctor-sqlite-"));
    try {
      const healthyPath = Path.join(tempDir, "healthy.sqlite");
      const db = new DatabaseSync(healthyPath);
      db.exec(
        "PRAGMA journal_mode = WAL; CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT); INSERT INTO effect_sql_migrations VALUES (1, 'init');",
      );
      db.close();

      const healthyResult = await inspectSqliteReadOnly(healthyPath, tempDir);
      expect(healthyResult?.kind).toBe("ok");
      if (healthyResult?.kind === "ok") {
        expect(healthyResult.snapshot.quickCheck).toEqual(["ok"]);
        expect(healthyResult.snapshot.migrationCount).toBe(1);
        expect(healthyResult.snapshot.latestMigrationId).toBe(1);
      }

      const corruptPath = Path.join(tempDir, "corrupt.sqlite");
      await FS.writeFile(corruptPath, "definitely not a sqlite database header");
      const corruptResult = await inspectSqliteReadOnly(corruptPath, tempDir);
      expect(corruptResult?.kind).toBe("corrupt");

      const report = await runDoctorDiagnostics({
        mode: "cli",
        stateDir: tempDir,
        dbPath: corruptPath,
        worktreesDir: Path.join(tempDir, "worktrees"),
        logsDir: Path.join(tempDir, "logs"),
        attachmentsDir: Path.join(tempDir, "attachments"),
        env: { PATH: process.env.PATH },
        homeDir: tempDir,
      });
      expect(report.overallStatus).toBe("error");
      expect(report.checks.find((check) => check.id === "db.integrity")?.status).toBe("error");
    } finally {
      await FS.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports healthy SQLite DB, flags legacy T3CODE_* names, scrubs planted secrets, and validates against schema", async () => {
    const tempDir = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-doctor-test-"));
    try {
      const stateDir = Path.join(tempDir, "userdata");
      const worktreesDir = Path.join(tempDir, "worktrees");
      const logsDir = Path.join(stateDir, "logs");
      const attachmentsDir = Path.join(stateDir, "attachments");
      const dbPath = Path.join(stateDir, "state.sqlite");
      await FS.mkdir(logsDir, { recursive: true });
      await FS.mkdir(attachmentsDir, { recursive: true });
      await FS.mkdir(worktreesDir, { recursive: true });
      await FS.writeFile(dbPath, "placeholder");

      const liveProviders: ReadonlyArray<ServerProvider> = [
        {
          instanceId: "opencode-default",
          provider: "opencode",
          driver: "opencode",
          displayName: "OpenCode",
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "warning",
          auth: { status: "authenticated" },
          checkedAt: "2026-11-25T00:00:00.000Z",
          message:
            "Server http://127.0.0.1:4096/?token=planted_query_secret_999 failed for user@secret-corp.com with sk-ant-planted1234567890",
          models: [],
          slashCommands: [],
          skills: [],
        } as unknown as ServerProvider,
      ];

      const report = await runDoctorDiagnostics({
        mode: "cli",
        stateDir,
        dbPath,
        worktreesDir,
        logsDir,
        attachmentsDir,
        profileSlug: "default",
        profileName: "Default",
        isDefaultProfile: true,
        host: "127.0.0.2",
        port: 3773,
        authEnabled: false,
        liveProviders,
        env: {
          PATH: process.env.PATH,
          T3CODE_AUTH_TOKEN: "super-secret-value-never-output",
          T3CODE_PORT: "3773",
        },
        homeDir: tempDir,
        inspectSqlite: async () => ({
          kind: "ok",
          snapshot: {
            quickCheck: ["ok"],
            pageSize: 4096,
            pageCount: 120,
            freelistCount: 10,
            autoVacuum: 2,
            journalMode: "wal",
            migrationCount: 178,
            latestMigrationId: 178,
          },
        }),
      });

      expect(Schema.decodeUnknownSync(ServerDoctorReport)(report)).toEqual(report);

      const envCheck = report.checks.find((check) => check.id === "env.legacy-vars");
      expect(envCheck?.status).toBe("warn");
      expect(envCheck?.summary).toContain("T3CODE_AUTH_TOKEN");
      expect(envCheck?.summary).toContain("T3CODE_PORT");

      // 127.0.0.2 is in 127.0.0.0/8 loopback so no auth is required.
      expect(report.checks.find((check) => check.id === "env.network")?.status).toBe("ok");

      const dbCheck = report.checks.find((check) => check.id === "db.integrity");
      expect(dbCheck?.status).toBe("ok");
      expect(dbCheck?.summary).toContain("178 migrations applied");

      const serialized = JSON.stringify(buildRedactedSupportBundle({ report }));
      expect(serialized).not.toContain("super-secret-value-never-output");
      expect(serialized).not.toContain("planted_query_secret_999");
      expect(serialized).not.toContain("user@secret-corp.com");
      expect(serialized).not.toContain("sk-ant-planted1234567890");
      expect(serialized).not.toContain(tempDir);

      const formatted = formatDoctorReportText(report);
      expect(formatted).toContain("F5 Doctor:");
      expect(formatted).toContain("SQLite integrity & schema");
      expect(formatted).not.toContain("super-secret-value-never-output");
    } finally {
      await FS.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("supports live non-blocking metadata inspection, desktop F5_* env without warnings, and counts nested + custom worktree checkouts", async () => {
    const tempDir = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-doctor-desktop-"));
    try {
      const stateDir = Path.join(tempDir, "userdata");
      const defaultWorktrees = Path.join(tempDir, "worktrees");
      const customRootParent = Path.join(tempDir, "custom-wt");
      const customManaged = customWorktreesDirectory(customRootParent, defaultWorktrees);
      await FS.mkdir(Path.join(defaultWorktrees, "repo-a", "wt-1"), { recursive: true });
      await FS.mkdir(Path.join(defaultWorktrees, "repo-a", "wt-2"), { recursive: true });
      await FS.mkdir(Path.join(customManaged, "repo-b", "wt-3"), { recursive: true });
      await FS.mkdir(stateDir, { recursive: true });
      await FS.writeFile(
        Path.join(stateDir, "settings.json"),
        JSON.stringify({ worktreesDirectory: customRootParent }),
      );
      const dbPath = Path.join(stateDir, "state.sqlite");
      await FS.writeFile(dbPath, "live");

      const report = await runDoctorDiagnostics({
        mode: "desktop",
        stateDir,
        dbPath,
        worktreesDir: defaultWorktrees,
        logsDir: Path.join(stateDir, "logs"),
        attachmentsDir: Path.join(stateDir, "attachments"),
        env: {
          PATH: process.env.PATH,
          F5_MODE: "desktop",
          F5_NO_BROWSER: "1",
          F5_PORT: "3773",
          F5_STATE_DIR: stateDir,
        },
        homeDir: tempDir,
        inspectSqlite: async () => ({
          kind: "ok",
          snapshot: {
            quickCheck: null,
            pageSize: 4096,
            pageCount: 50,
            freelistCount: 5,
            autoVacuum: 2,
            journalMode: "wal",
            migrationCount: 178,
            latestMigrationId: 178,
          },
        }),
      });

      expect(report.checks.find((check) => check.id === "env.legacy-vars")?.status).toBe("ok");
      const dbCheck = report.checks.find((check) => check.id === "db.integrity");
      expect(dbCheck?.status).toBe("ok");
      expect(dbCheck?.summary).toContain("Live metadata OK");
      expect(dbCheck?.hint).toContain("f5 doctor");

      const wtCheck = report.checks.find((check) => check.id === "storage.worktrees");
      expect(wtCheck?.status).toBe("ok");
      expect(wtCheck?.summary).toContain("3 checkouts across 2 managed roots");
    } finally {
      await FS.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports error status when SQLite quick_check fails or non-loopback host lacks auth", async () => {
    const tempDir = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-doctor-err-"));
    try {
      const stateDir = Path.join(tempDir, "userdata");
      const dbPath = Path.join(stateDir, "state.sqlite");
      await FS.mkdir(stateDir, { recursive: true });
      await FS.writeFile(dbPath, "corrupt");

      const report = await runDoctorDiagnostics({
        mode: "web",
        stateDir,
        dbPath,
        worktreesDir: Path.join(tempDir, "worktrees"),
        logsDir: Path.join(stateDir, "logs"),
        attachmentsDir: Path.join(stateDir, "attachments"),
        host: "0.0.0.0",
        port: 3773,
        authEnabled: false,
        env: { PATH: process.env.PATH },
        homeDir: tempDir,
        inspectSqlite: async () => ({
          kind: "ok",
          snapshot: {
            quickCheck: ["row 1 missing from index idx_foo"],
            pageSize: 4096,
            pageCount: 10,
            freelistCount: 0,
            autoVacuum: 2,
            journalMode: "wal",
            migrationCount: 10,
            latestMigrationId: 10,
          },
        }),
      });

      expect(report.overallStatus).toBe("error");
      expect(report.checks.find((check) => check.id === "env.network")?.status).toBe("error");
      expect(report.checks.find((check) => check.id === "db.integrity")?.status).toBe("error");
    } finally {
      await FS.rm(tempDir, { recursive: true, force: true });
    }
  });
});
