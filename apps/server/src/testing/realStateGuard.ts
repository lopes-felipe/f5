/**
 * realStateGuard - Detects test runs that damaged a real F5 profile database.
 *
 * The F5 app may be running and writing these files during the run, so only
 * the SQLite header is compared. A database that disappears is reported
 * separately (the user may have deleted a profile) and does not fail the run.
 *
 * @module realStateGuard
 */
import * as FS from "node:fs";
import * as Path from "node:path";

const SQLITE_HEADER = "SQLite format 3\0";

/** Profile databases under a home: current, dev and per-profile, plus legacy `~/.t3`. */
export function profileDatabases(home: string): string[] {
  const paths: string[] = [];
  for (const stateRoot of [".f5", ".t3"]) {
    const root = Path.join(home, stateRoot);
    paths.push(Path.join(root, "userdata", "state.sqlite"), Path.join(root, "dev", "state.sqlite"));
    try {
      for (const entry of FS.readdirSync(Path.join(root, "userdata-profiles"), {
        withFileTypes: true,
      })) {
        if (entry.isDirectory()) {
          paths.push(Path.join(root, "userdata-profiles", entry.name, "state.sqlite"));
        }
      }
    } catch {
      // No profiles directory.
    }
  }
  return paths;
}

type HeaderState = "sqlite" | "damaged" | "missing";

function headerState(path: string): HeaderState {
  let fd: number;
  try {
    fd = FS.openSync(path, "r");
  } catch {
    return "missing";
  }
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const read = FS.readSync(fd, header, 0, header.length, 0);
    return read === header.length && header.toString("latin1") === SQLITE_HEADER
      ? "sqlite"
      : "damaged";
  } finally {
    FS.closeSync(fd);
  }
}

export interface RealStateCheck {
  readonly damaged: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
}

/** Records every healthy profile database; the returned function re-checks them. */
export function watchProfileDatabases(homes: ReadonlyArray<string>): () => RealStateCheck {
  const healthy = [...new Set(homes.flatMap(profileDatabases))].filter(
    (path) => headerState(path) === "sqlite",
  );
  return () => {
    const damaged: string[] = [];
    const missing: string[] = [];
    for (const path of healthy) {
      const state = headerState(path);
      if (state === "damaged") damaged.push(path);
      else if (state === "missing") missing.push(path);
    }
    return { damaged, missing };
  };
}
