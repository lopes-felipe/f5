import { describe, expect, it } from "vitest";
import { evidenceSource } from "./evidenceSource";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const git = (status: string) => (args: ReadonlyArray<string>) =>
  args[0] === "rev-parse" ? `${COMMIT}\n` : status;

describe("evidenceSource", () => {
  it("reports the commit and whether the checkout is clean", () => {
    expect(evidenceSource(git(""))).toEqual({ sourceCommit: COMMIT, dirty: false });
    expect(evidenceSource(git(" M apps/server/src/x.ts\n"))).toEqual({
      sourceCommit: COMMIT,
      dirty: true,
    });
    expect(evidenceSource(git("?? spike.json\n")).dirty).toBe(true);
  });

  it("treats an unreadable checkout as dirty", () => {
    expect(
      evidenceSource(() => {
        throw new Error("not a git repository");
      }),
    ).toEqual({ dirty: true });
    expect(evidenceSource(() => "HEAD\n")).toEqual({ dirty: true });
  });
});
