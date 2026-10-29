import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FLAKY_RECORD_FILE, type FlakyRecord } from "./ci-test-reports.ts";

export {
  appendFlakyRecords,
  FLAKY_RECORD_FILE,
  type FlakyRecord,
  flakyRecord,
  MAX_FLAKY_ERROR_BYTES,
  truncateUtf8,
} from "./ci-test-reports.ts";

const isString = (value: unknown): value is string => typeof value === "string";

/** Validate rather than trust: these files also arrive as downloaded artifacts. */
export function parseFlakyRecord(line: string): FlakyRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    (record.kind !== "test" && record.kind !== "step") ||
    !["suite", "file", "name", "os", "job", "runId", "runAttempt"].every((key) =>
      isString(record[key]),
    ) ||
    !Number.isSafeInteger(record.retryCount) ||
    !Array.isArray(record.errors) ||
    !record.errors.every(isString)
  )
    return undefined;
  return record as unknown as FlakyRecord;
}

/** Every flaky record below `directory`, in a stable path order. */
export function readFlakyRecords(directory: string): FlakyRecord[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name === FLAKY_RECORD_FILE) files.push(path);
    }
  };
  walk(directory);
  return files.sort().flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => parseFlakyRecord(line) ?? []),
  );
}
