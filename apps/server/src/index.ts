import { BACKUP_MAINTENANCE_MODE, runBackupMaintenanceMode } from "./backupMaintenance.ts";

// Route owned maintenance work before loading provider SDKs or normal server init.
if (process.argv.includes(BACKUP_MAINTENANCE_MODE)) {
  if (import.meta.url.endsWith(".ts") || process.env.F5_STANDALONE === "1") {
    void runBackupMaintenanceMode();
  } else {
    const entry = new URL(
      `./maintenance/backup-maintenance.${import.meta.url.endsWith(".cjs") ? "cjs" : "mjs"}`,
      import.meta.url,
    ).href;
    void import(entry).catch((error: unknown) => {
      console.error(String(error));
      process.exitCode = 1;
    });
  }
} else {
  void import("./serverEntrypoint.ts")
    .then(({ startServer }) => startServer())
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "F5 startup failed.");
      process.exitCode = 1;
    });
}
