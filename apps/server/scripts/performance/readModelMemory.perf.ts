import { fileURLToPath } from "node:url";
import { metadata } from "../../../../scripts/lib/performance/report.ts";
import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { measureEngineHydration, measureReadModelMemory } from "./assistantStream.ts";

// Child of measureReadModelMemory: one engine hydration in a fresh process.
it("measures engine hydration memory in a fresh process", async () => {
  const report = process.env.F5_PERF_DELETED_MEMORY_REPORT;
  if (report && !process.env.F5_PERF_READ_MODEL_DIR) {
    const observations = await measureReadModelMemory({ deletedPercent: 5 });
    writeFileSync(
      report,
      JSON.stringify({
        metadata: metadata(fileURLToPath(new URL("../../../../", import.meta.url))),
        method: { repetitions: 3, statistic: "median" },
        deletedPercent: 5,
        observations,
      }),
      { flag: "wx" },
    );
    return;
  }
  const directory = process.env.F5_PERF_READ_MODEL_DIR;
  const output = process.env.F5_PERF_READ_MODEL_OUTPUT;
  if (!directory || !output)
    throw new Error("Run through measureReadModelMemory; the seeded directory is required");
  const result = await measureEngineHydration(directory);
  writeFileSync(output, JSON.stringify(result), { flag: "wx" });
}, 300_000);
