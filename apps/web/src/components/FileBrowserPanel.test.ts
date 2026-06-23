import type { ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { resolveSearchEntryForEnter } from "./FileBrowserPanel";

const SEARCH_ENTRIES: ProjectEntry[] = [
  { path: "src/components", kind: "directory" },
  { path: "src/App.tsx", kind: "file" },
  { path: "README.md", kind: "file" },
];

describe("resolveSearchEntryForEnter", () => {
  it("uses the highlighted file when one is highlighted", () => {
    expect(resolveSearchEntryForEnter(SEARCH_ENTRIES, 1)?.path).toBe("src/App.tsx");
  });

  it("uses the highlighted directory when one is highlighted", () => {
    expect(resolveSearchEntryForEnter(SEARCH_ENTRIES, 0)?.path).toBe("src/components");
  });

  it("falls back to the first file when nothing is highlighted", () => {
    expect(resolveSearchEntryForEnter(SEARCH_ENTRIES, -1)?.path).toBe("src/App.tsx");
  });
});
