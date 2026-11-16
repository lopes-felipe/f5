import { delimiter } from "node:path";

import { watchProfileDatabases } from "../src/testing/realStateGuard.ts";

// Fails the run when a test damaged a real profile database.

export default function setup() {
  const homes = [
    process.env.F5_TEST_REAL_HOME,
    ...(process.env.F5_TEST_PROTECTED_HOMES?.split(delimiter) ?? []),
  ].filter((home): home is string => Boolean(home));
  if (homes.length === 0) return;
  const check = watchProfileDatabases(homes);
  return () => {
    const { damaged, missing } = check();
    if (missing.length > 0) {
      console.warn(`Real F5 profile databases disappeared during the run: ${missing.join(", ")}`);
    }
    if (damaged.length > 0) {
      // Vitest only logs globalSetup teardown errors; the exit code is ours to set.
      process.exitCode = 1;
      throw new Error(
        `Tests damaged real F5 profile databases: ${damaged.join(", ")}. ` +
          "Stop running tests and restore from the profile's backups/ snapshots.",
      );
    }
  };
}
