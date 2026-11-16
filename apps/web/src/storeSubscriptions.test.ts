import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = import.meta.dirname;
const WHOLE_THREADS_SUBSCRIPTION = /=> \(?(s|state|store)\)?\.threads\)/;

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.(test|browser)\.(ts|tsx)$/.test(entry)) continue;
    files.push(path);
  }
  return files;
}

describe("store subscriptions", () => {
  // Every streaming delta replaces `state.threads`, so subscribing to the
  // whole array re-renders the subscriber for each token. Use the selectors
  // in `threadSelectors.ts` (summaries, ordered ids, `useThread`) instead.
  it("never subscribes to the whole threads array", () => {
    const offenders = sourceFiles(SOURCE_ROOT).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          WHOLE_THREADS_SUBSCRIPTION.test(line)
            ? [`${relative(SOURCE_ROOT, path)}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    );
    expect(offenders).toEqual([]);
  });
});
