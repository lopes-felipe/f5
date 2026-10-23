import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { summarizeTraceFile } from "./traceSummary.ts";

it("streams traces, counts failures and stalls, and bounds malformed lines and the top list", async () => {
  const directory = await mkdtemp(join(tmpdir(), "f5-trace-summary-"));
  try {
    const file = join(directory, "traces.ndjson");
    await writeFile(
      file,
      [
        "broken",
        "x".repeat(4 * 1024 * 1024 + 1),
        ...Array.from({ length: 100 }, (_, i) =>
          JSON.stringify({
            name: i === 99 ? "event-loop.stall" : `span-${i}`,
            durationMs: i,
            exit: { _tag: i % 2 ? "Failure" : "Success" },
          }),
        ),
      ].join("\n"),
    );
    const result = await summarizeTraceFile(file);
    expect(result).toMatchObject({ records: 100, malformed: 2, errors: 50, stalls: 1 });
    expect(result.slowest).toHaveLength(20);
    expect(result.slowest[0]).toEqual({ name: "event-loop.stall", durationMs: 99 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
