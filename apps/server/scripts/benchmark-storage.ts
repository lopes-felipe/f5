import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { performance } from "node:perf_hooks";
import { measureTree, readStorageStat, type DiskUsageFs } from "../src/storage/diskUsage.ts";

const count = Number(process.argv[2] ?? 100_000);
if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000)
  throw new Error("File count must be between 1 and 1,000,000.");
const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-storage-benchmark-"));
try {
  let nextDirectory = 0;
  const directories = Math.ceil(count / 1000);
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      for (;;) {
        const directory = nextDirectory++;
        if (directory >= directories) return;
        const path = Path.join(root, String(directory));
        await FS.mkdir(path);
        for (let index = directory * 1000; index < Math.min(count, (directory + 1) * 1000); index++)
          await FS.writeFile(Path.join(path, String(index)), "");
      }
    }),
  );
  let inFlight = 0,
    maxInFlight = 0,
    calls = 0;
  const tracked = async <A>(call: () => Promise<A>) => {
    calls++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await call();
    } finally {
      inFlight--;
    }
  };
  const fs: DiskUsageFs = {
    lstat: (path) => tracked(() => readStorageStat(path)),
    readdir: (path, options) => tracked(() => FS.readdir(path, options)),
  };
  const initialRss = process.memoryUsage().rss;
  let peakRss = initialRss,
    lastTick = performance.now(),
    maxEventLoopLagMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxEventLoopLagMs = Math.max(maxEventLoopLagMs, now - lastTick - 10);
    lastTick = now;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 10);
  const start = performance.now();
  try {
    const checkpoints = [
      root,
      ...Array.from({ length: Math.min(69, directories) }, (_, index) =>
        Path.join(root, String(index)),
      ),
    ];
    const result = await measureTree([root], { checkpoints, fs });
    process.stdout.write(
      `${JSON.stringify({ fileCount: count, checkpoints: checkpoints.length, entries: result.entries, durationMs: Math.round(performance.now() - start), fsCalls: calls, maxInFlight, peakRssGrowthBytes: peakRss - initialRss, maxEventLoopLagMs: Math.round(maxEventLoopLagMs), warnings: result.warnings.length })}\n`,
    );
    if (result.entries !== count + directories + 1 || maxInFlight > 16 || result.warnings.length)
      process.exitCode = 1;
  } finally {
    clearInterval(timer);
  }
} finally {
  await FS.rm(root, { recursive: true, force: true });
}
