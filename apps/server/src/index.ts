import { BACKUP_MAINTENANCE_MODE, runBackupMaintenanceMode } from "./backupMaintenance.ts";
import { claimGuestFrameFds } from "./computer/guestFrameFds.ts";

// A Linux VM guest backend inherits its desktop channel on fds 3 and 4. Make them private
// before anything can start a child process, or refuse to start (78: startup refused).
if (process.env.F5_DESKTOP_COMPUTER_HOST === "frames") {
  try {
    claimGuestFrameFds();
  } catch (error) {
    console.error(
      `F5 won't start: the desktop channel can't be made private (${error instanceof Error ? error.message : String(error)}).`,
    );
    process.exit(78);
  }
}

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
