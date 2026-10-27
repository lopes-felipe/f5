import { describe, expect, it } from "vitest";
import { orderPrFiles, prFileTier } from "./prFileOrder";
import type { PrHubChangedFile } from "@t3tools/contracts";

const file = (path: string, patch = ""): PrHubChangedFile => ({
  path,
  patch,
  additions: 1,
  deletions: 0,
  changeType: "changed",
});
describe("PR file reading order", () => {
  it("puts dependencies before consumers, then matching tests, then generated output", () => {
    const files = [
      file("bun.lock"),
      file("src/a.test.ts"),
      file("src/z.ts"),
      file("src/a.ts", '+import { z } from "./z.js"'),
      file("src/z.test.ts"),
    ];
    expect(orderPrFiles(files).map((entry) => entry.path)).toEqual([
      "src/z.ts",
      "src/a.ts",
      "src/z.test.ts",
      "src/a.test.ts",
      "bun.lock",
    ]);
    expect(files[0]?.path).toBe("bun.lock");
  });
  it("terminates cycles and leaves ambiguous module names unresolved", () => {
    const files = [
      file("b.ts", 'import "./a"'),
      file("a.ts", 'import "./b"'),
      file("one/c.ts"),
      file("two/c.ts"),
      file("d.ts", 'import "c"'),
    ];
    expect(orderPrFiles(files)).toHaveLength(5);
    expect(orderPrFiles(files)).toEqual(orderPrFiles([...files].reverse()));
  });
  it("classifies generated tests as generated", () => {
    expect(prFileTier("dist/example.test.js")).toBe("generated");
    expect(prFileTier("tests/example.ts")).toBe("test");
  });
});
