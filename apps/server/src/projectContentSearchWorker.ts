/**
 * Source for the killable project-content worker.
 *
 * Keeping this closure self-contained lets both Bun's source runtime and the
 * bundled Node runtime start the exact same worker with `eval: true`. It also
 * means cancellation can terminate native grep work immediately without
 * requiring a second emitted build artifact.
 */
function projectContentSearchWorkerMain(): void {
  type FileFinder = import("@ff-labs/fff-node").FileFinder;
  type GrepCursor = import("@ff-labs/fff-node").GrepCursor;
  type GrepResult = import("@ff-labs/fff-node").GrepResult;
  type ParentPort = import("node:worker_threads").MessagePort;

  type WorkerRequest =
    | { readonly id: number; readonly type: "initialize"; readonly rootPath: string }
    | { readonly id: number; readonly type: "refresh" }
    | {
        readonly id: number;
        readonly type: "search";
        readonly query: string;
        readonly limit: number;
        readonly caseSensitive: boolean;
        readonly wholeWord: boolean;
        readonly useRegex: boolean;
      }
    | { readonly id: number; readonly type: "dispose" };

  const { parentPort } = require("node:worker_threads") as {
    readonly parentPort: ParentPort | null;
  };
  if (!parentPort) {
    throw new Error("Project content search worker requires a parent port.");
  }

  const MAX_INDEXED_PATHS = 25_000;
  const MAX_MATCHES_PER_FILE = 100;
  const MAX_SEARCH_MATCHES = 500;
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const SCAN_TIMEOUT_MS = 15_000;
  const SEARCH_BUDGET_MS = 250;
  const MAX_LINE_CONTENT_BYTES = 8 * 1024;
  const MAX_MATCH_RANGES = 256;
  const WORD_CHARACTER = /[\p{Letter}\p{Mark}\p{Number}_]/u;

  let finder: FileFinder | null = null;
  let indexedPathCount = 0;
  let indexTruncated = false;

  const delay = (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

  function postError(id: number, cause: unknown): void {
    parentPort!.postMessage({
      id,
      type: "error",
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }

  function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  async function waitForIndexReady(): Promise<void> {
    if (!finder) throw new Error("Content index is not initialized.");
    const deadline = Date.now() + SCAN_TIMEOUT_MS;
    while (true) {
      const progress = unwrap(finder.getScanProgress());
      indexedPathCount = progress.scannedFilesCount;
      indexTruncated ||= indexedPathCount > MAX_INDEXED_PATHS;
      if (!progress.isScanning && progress.isWarmupComplete) return;
      if (Date.now() >= deadline) {
        throw new Error("Project content index scan timed out after 15 seconds.");
      }
      await delay(25);
    }
  }

  async function initialize(rootPath: string): Promise<void> {
    finder?.destroy();
    // Avoid bundler-specific dynamic-import helpers leaking into this
    // function's serialized worker source.
    const dynamicImport = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<typeof import("@ff-labs/fff-node")>;
    const fff = await dynamicImport("@ff-labs/fff-node");
    finder = unwrap(
      fff.FileFinder.create({
        basePath: rootPath,
        disableMmapCache: false,
        disableContentIndexing: false,
        disableWatch: true,
        aiMode: false,
        cacheBudgetMaxFiles: MAX_INDEXED_PATHS,
        cacheBudgetMaxFileSize: MAX_FILE_BYTES,
        enableFsRootScanning: false,
        enableHomeDirScanning: false,
      }),
    );
    await waitForIndexReady();
  }

  async function refresh(): Promise<void> {
    if (!finder) throw new Error("Content index is not initialized.");
    unwrap(finder.scanFiles());
    await waitForIndexReady();
  }

  function byteOffsetToCodePointOffset(bytes: Buffer, byteOffset: number): number {
    const boundedOffset = Math.max(0, Math.min(bytes.byteLength, byteOffset));
    return Array.from(bytes.subarray(0, boundedOffset).toString("utf8")).length;
  }

  function mapRanges(
    bytes: Buffer,
    ranges: ReadonlyArray<readonly [number, number]>,
  ): Array<{ readonly start: number; readonly end: number }> {
    return ranges
      .slice(0, MAX_MATCH_RANGES)
      .map(([start, end]) => ({
        start: byteOffsetToCodePointOffset(bytes, start),
        end: byteOffsetToCodePointOffset(bytes, end),
      }))
      .filter((range) => range.end > range.start);
  }

  function boundedLineMatch(
    line: string,
    ranges: ReadonlyArray<readonly [number, number]>,
  ): {
    readonly lineContent: string;
    readonly matchRanges: Array<{ readonly start: number; readonly end: number }>;
    readonly truncated: boolean;
  } | null {
    const firstRange = ranges[0];
    if (!firstRange) return null;
    const lineBytes = Buffer.from(line, "utf8");
    let windowStart = Math.max(0, firstRange[0] - Math.floor(MAX_LINE_CONTENT_BYTES / 4));
    while (windowStart > 0 && (lineBytes[windowStart]! & 0xc0) === 0x80) windowStart -= 1;
    let windowEnd = Math.min(lineBytes.byteLength, windowStart + MAX_LINE_CONTENT_BYTES);
    while (windowEnd > windowStart && (lineBytes[windowEnd]! & 0xc0) === 0x80) windowEnd -= 1;
    const snippetBytes = lineBytes.subarray(windowStart, windowEnd);
    const adjustedRanges = ranges
      .slice(0, MAX_MATCH_RANGES)
      .filter(([start, end]) => start >= windowStart && end <= windowEnd)
      .map(([start, end]) => [start - windowStart, end - windowStart] as const);
    return {
      lineContent: snippetBytes.toString("utf8"),
      matchRanges: mapRanges(snippetBytes, adjustedRanges),
      truncated:
        windowStart > 0 || windowEnd < lineBytes.byteLength || ranges.length > MAX_MATCH_RANGES,
    };
  }

  function isWholeWordRange(
    line: string,
    range: { readonly start: number; readonly end: number },
  ): boolean {
    const codePoints = Array.from(line);
    const isWord = (character: string | undefined) =>
      character !== undefined && WORD_CHARACTER.test(character);
    const leftIsBoundary =
      range.start === 0 || !isWord(codePoints[range.start - 1]) || !isWord(codePoints[range.start]);
    const rightIsBoundary =
      range.end >= codePoints.length ||
      !isWord(codePoints[range.end]) ||
      !isWord(codePoints[range.end - 1]);
    return leftIsBoundary && rightIsBoundary;
  }

  function buildSearchQuery(input: {
    readonly query: string;
    readonly caseSensitive: boolean;
    readonly useRegex: boolean;
  }): { readonly query: string; readonly mode: "plain" | "regex" } {
    if (input.caseSensitive) {
      return { query: input.query, mode: input.useRegex ? "regex" : "plain" };
    }
    return input.useRegex
      ? { query: `(?i)${input.query}`, mode: "regex" }
      : { query: input.query.toLocaleLowerCase(), mode: "plain" };
  }

  function search(input: Extract<WorkerRequest, { readonly type: "search" }>) {
    if (!finder) throw new Error("Content index is not initialized.");
    const limit = Math.min(MAX_SEARCH_MATCHES, Math.max(1, input.limit));
    const searchQuery = buildSearchQuery(input);
    const deadline = performance.now() + SEARCH_BUDGET_MS;
    const matches: Array<{
      readonly path: string;
      readonly lineNumber: number;
      readonly lineContent: string;
      readonly matchRanges: Array<{ readonly start: number; readonly end: number }>;
    }> = [];
    const matchesPerPath = new Map<string, number>();
    let cursor: GrepCursor | null = null;
    let regexFallbackError: string | undefined;
    let processingTruncated = false;

    do {
      const remainingTimeBudgetMs = Math.max(1, Math.ceil(deadline - performance.now()));
      const page: GrepResult = unwrap(
        finder.grep(searchQuery.query, {
          mode: searchQuery.mode,
          smartCase: !input.caseSensitive && searchQuery.mode === "plain",
          maxFileSize: MAX_FILE_BYTES,
          maxMatchesPerFile: MAX_MATCHES_PER_FILE,
          pageSize: Math.max(limit, input.wholeWord ? MAX_MATCHES_PER_FILE : 1),
          cursor,
          timeBudgetMs: remainingTimeBudgetMs,
        }),
      );
      for (const match of page.items) {
        if (performance.now() >= deadline) {
          processingTruncated = true;
          break;
        }
        const normalizedPath = match.relativePath.replaceAll("\\", "/");
        const currentPathCount = matchesPerPath.get(normalizedPath) ?? 0;
        if (currentPathCount >= MAX_MATCHES_PER_FILE) continue;
        const bounded = boundedLineMatch(match.lineContent, match.matchRanges);
        if (!bounded) continue;
        processingTruncated ||= bounded.truncated;
        const matchRanges = bounded.matchRanges.filter(
          (range) => !input.wholeWord || isWholeWordRange(bounded.lineContent, range),
        );
        if (matchRanges.length === 0) continue;
        matches.push({
          path: normalizedPath,
          lineNumber: match.lineNumber,
          lineContent: bounded.lineContent,
          matchRanges,
        });
        matchesPerPath.set(normalizedPath, currentPathCount + 1);
        if (matches.length > limit) break;
      }
      cursor = page.nextCursor;
      regexFallbackError ??= page.regexFallbackError;
    } while (matches.length <= limit && cursor !== null && performance.now() < deadline);

    return {
      matches: matches.slice(0, limit),
      truncated: matches.length > limit || cursor !== null || indexTruncated || processingTruncated,
      indexedPathCount: Math.min(indexedPathCount, MAX_INDEXED_PATHS),
      indexTruncated,
      ...(regexFallbackError !== undefined ? { regexFallbackError } : {}),
    };
  }

  parentPort.on("message", (message: WorkerRequest) => {
    void (async () => {
      try {
        switch (message.type) {
          case "initialize":
            await initialize(message.rootPath);
            parentPort.postMessage({
              id: message.id,
              type: "result",
              value: { indexedPathCount, indexTruncated },
            });
            return;
          case "refresh":
            await refresh();
            parentPort.postMessage({
              id: message.id,
              type: "result",
              value: { indexedPathCount, indexTruncated },
            });
            return;
          case "search":
            parentPort.postMessage({ id: message.id, type: "result", value: search(message) });
            return;
          case "dispose":
            finder?.destroy();
            finder = null;
            parentPort.postMessage({ id: message.id, type: "result", value: null });
            return;
        }
      } catch (cause) {
        postError(message.id, cause);
      }
    })();
  });
}

export const PROJECT_CONTENT_SEARCH_WORKER_SOURCE = `(${projectContentSearchWorkerMain.toString()})();`;
