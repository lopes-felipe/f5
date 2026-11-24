import { describe, expect, it } from "vitest";
import { completionCandidates } from "./completionCandidates.ts";

describe("forge completion candidates", () => {
  it("filters, deduplicates and validates inserted tokens", () => {
    expect(
      completionCandidates(
        [
          { login: "alice", name: "Alice" },
          { username: "alice" },
          { login: "bad user" },
          { login: "bob" },
        ],
        "@",
        "ali",
      ),
    ).toEqual([{ token: "@alice", label: "alice", detail: "Alice" }]);
    expect(
      completionCandidates(
        [{ iid: 12, title: "Fix cache" }, { number: -1 }, { iid: 13, title: "Other" }],
        "!",
        "cache",
      ),
    ).toEqual([{ token: "!12", label: "!12", detail: "Fix cache" }]);
  });
  it("bounds empty-query suggestions", () => {
    expect(
      completionCandidates(
        Array.from({ length: 200 }, (_, i) => ({ number: i + 1 })),
        "#",
        "",
      ),
    ).toHaveLength(10);
  });
});
