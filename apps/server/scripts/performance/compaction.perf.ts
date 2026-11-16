import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { fixture } from "../../../../scripts/lib/performance/fixtures.ts";
import { metadata } from "../../../../scripts/lib/performance/report.ts";
import { measureCompaction } from "./compaction.ts";

it("records the largest atomic compaction group and concurrent writer wait", async () => {
  const output = process.env.F5_PERF_REPORT;
  if (!output) throw new Error("F5_PERF_REPORT is required");
  const directory = mkdtempSync(join(tmpdir(), "f5-compaction-perf-"));
  try {
    const result = await measureCompaction(join(directory, "state.sqlite"), fixture.method);
    writeFileSync(
      output,
      JSON.stringify(
        {
          metadata: metadata(fileURLToPath(new URL("../../../../", import.meta.url))),
          method: fixture.method,
          ...result,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);
