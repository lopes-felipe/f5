import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { ServerDoctorReport } from "@t3tools/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  buildRedactedSupportBundle,
  formatDoctorReportText,
  redactDiagnosticText,
  runDoctorDiagnostics,
} from "./doctor.ts";

describe("doctor diagnostics", () => {
  it("redacts user home paths and inline URL credentials", () => {
    const redacted = redactDiagnosticText(
      "Reading /Users/alice/.f5/userdata/state.sqlite via https://alice:s3cr3t@example.com/hook",
      "/Users/alice",
    );
    expect(redacted).toBe("Reading ~/.f5/userdata/state.sqlite via https://***@example.com/hook");
    expect(redacted).not.toContain("alice");
    expect(redacted).not.toContain("s3cr3t");
  });

  it("reports healthy SQLite DB, flags legacy T3CODE_* names without leaking values, and validates against schema", async () => {
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
        env: {
          PATH: process.env.PATH,
          T3CODE_AUTH_TOKEN: "super-secret-value-never-output",
          T3CODE_PORT: "3773",
        },
        homeDir: tempDir,
        inspectSqlite: async () => ({
          quickCheck: ["ok"],
          pageSize: 4096,
          pageCount: 120,
          freelistCount: 10,
          autoVacuum: 2,
          journalMode: "wal",
          migrationCount: 178,
          latestMigrationId: 178,
        }),
      });

      expect(Schema.decodeUnknownSync(ServerDoctorReport)(report)).toEqual(report);

      const envCheck = report.checks.find((check) => check.id === "env.legacy-vars");
      expect(envCheck?.status).toBe("warn");
      expect(envCheck?.summary).toContain("T3CODE_AUTH_TOKEN");
      expect(envCheck?.summary).toContain("T3CODE_PORT");

      const dbCheck = report.checks.find((check) => check.id === "db.integrity");
      expect(dbCheck?.status).toBe("ok");
      expect(dbCheck?.summary).toContain("178 migrations applied");

      const serialized = JSON.stringify(buildRedactedSupportBundle({ report }));
      expect(serialized).not.toContain("super-secret-value-never-output");
      expect(serialized).not.toContain(tempDir);

      const formatted = formatDoctorReportText(report);
      expect(formatted).toContain("F5 Doctor —");
      expect(formatted).toContain("SQLite integrity & schema");
      expect(formatted).not.toContain("super-secret-value-never-output");
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
          quickCheck: ["row 1 missing from index idx_foo"],
          pageSize: 4096,
          pageCount: 10,
          freelistCount: 0,
          autoVacuum: 2,
          journalMode: "wal",
          migrationCount: 10,
          latestMigrationId: 10,
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
