import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

// Fails the run when a test damaged a real profile database. The F5 app may be
// running and writing these files, so only the SQLite header is compared.

const SQLITE_HEADER = "SQLite format 3\0";

function profileDatabases(realHome: string): string[] {
  const root = join(realHome, ".f5");
  const paths = [join(root, "userdata", "state.sqlite"), join(root, "dev", "state.sqlite")];
  try {
    for (const entry of readdirSync(join(root, "userdata-profiles"), { withFileTypes: true }))
      if (entry.isDirectory())
        paths.push(join(root, "userdata-profiles", entry.name, "state.sqlite"));
  } catch {
    // No profiles directory.
  }
  return paths;
}

function hasSqliteHeader(path: string): boolean | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    readSync(fd, header, 0, header.length, 0);
    return header.toString("latin1") === SQLITE_HEADER;
  } finally {
    closeSync(fd);
  }
}

export default function setup() {
  const realHome = process.env.F5_TEST_REAL_HOME;
  if (!realHome) return;
  const healthy = profileDatabases(realHome).filter((path) => hasSqliteHeader(path) === true);
  return () => {
    const damaged = healthy.filter((path) => hasSqliteHeader(path) !== true);
    if (damaged.length > 0) {
      throw new Error(
        `Tests damaged real F5 profile databases: ${damaged.join(", ")}. ` +
          "Stop running tests and restore from the profile's backups/ snapshots.",
      );
    }
  };
}
