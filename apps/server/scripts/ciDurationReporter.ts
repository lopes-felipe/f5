import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Reporter, TestModule } from "vitest/node";
import { reportPath } from "../../../scripts/lib/ci-test-reports.ts";

/** Include collection/import and worker setup, which Vitest's JSON test duration omits. */
export class CiDurationReporter implements Reporter {
  onTestRunEnd(modules: readonly TestModule[]) {
    const directory = process.env.F5_CI_REPORT_DIR;
    const suite = process.env.F5_CI_SUITE_ID;
    if (!directory || !suite) return;
    const file = resolve(directory, reportPath({ packageName: "suites", event: suite })).replace(
      /results\.json$/,
      "durations.timings",
    );
    const durationsMs = Object.fromEntries(
      modules.map((module) => {
        const d = module.diagnostic();
        return [
          module.moduleId,
          Math.max(
            1,
            d.duration +
              d.collectDuration +
              d.setupDuration +
              d.prepareDuration +
              d.environmentSetupDuration,
          ),
        ];
      }),
    );
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, durationsMs }, null, 2) + "\n");
  }
}
