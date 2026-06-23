import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { PROJECT_LIST_ENTRIES_MAX_LIMIT, ProjectListEntriesInput } from "./project";

const decodeProjectListEntriesInput = Schema.decodeUnknownSync(ProjectListEntriesInput);

describe("ProjectListEntriesInput", () => {
  it("accepts the maximum workspace file tree entry limit", () => {
    const parsed = decodeProjectListEntriesInput({
      cwd: "/repo/project",
      limit: PROJECT_LIST_ENTRIES_MAX_LIMIT,
    });

    expect(parsed.limit).toBe(PROJECT_LIST_ENTRIES_MAX_LIMIT);
  });

  it("rejects workspace file tree entry limits above the maximum", () => {
    expect(() =>
      decodeProjectListEntriesInput({
        cwd: "/repo/project",
        limit: PROJECT_LIST_ENTRIES_MAX_LIMIT + 1,
      }),
    ).toThrow();
  });
});
