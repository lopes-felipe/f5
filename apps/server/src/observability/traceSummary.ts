import { createReadStream } from "node:fs";

/** Read diagnostics incrementally, retaining only one bounded line. */
export async function summarizeTraceFile(filename: string) {
  let pending = "";
  let oversized = false;
  let records = 0;
  let malformed = 0;
  let errors = 0;
  let stalls = 0;
  const slowest: Array<{ name: string; durationMs: number }> = [];
  const accept = (line: string) => {
    if (!line.trim()) return;
    try {
      const value: unknown = JSON.parse(line);
      if (
        !value ||
        typeof value !== "object" ||
        !("name" in value) ||
        typeof value.name !== "string" ||
        !("durationMs" in value) ||
        typeof value.durationMs !== "number" ||
        !Number.isFinite(value.durationMs) ||
        value.durationMs < 0
      )
        throw new Error("Invalid span");
      records++;
      const exit = "exit" in value ? value.exit : undefined;
      if (exit && typeof exit === "object" && "_tag" in exit && exit._tag === "Failure") errors++;
      if (/event.loop.*stall/i.test(value.name)) stalls++;
      slowest.push({ name: value.name.slice(0, 256), durationMs: value.durationMs });
      slowest.sort((a, b) => b.durationMs - a.durationMs);
      if (slowest.length > 20) slowest.pop();
    } catch {
      malformed++;
    }
  };
  const stream = createReadStream(filename, { encoding: "utf8", highWaterMark: 64 * 1024 });
  for await (const chunk of stream) {
    for (const part of String(chunk).split(/(?<=\n)/)) {
      if (!oversized) {
        if (pending.length + part.length > 4 * 1024 * 1024) {
          pending = "";
          oversized = true;
        } else pending += part;
      }
      if (part.endsWith("\n")) {
        if (oversized) malformed++;
        else accept(pending);
        pending = "";
        oversized = false;
      }
    }
  }
  if (oversized) malformed++;
  else accept(pending);
  return { records, malformed, errors, stalls, slowest };
}
