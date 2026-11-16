import { describe, expect, it } from "vitest";
import { orderPrFiles, orderPrFilePages, prFileTier } from "./prFileOrder";
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
    expect(prFileTier("build/script.ts")).toBe("source");
    expect(prFileTier("vendor/library.ts")).toBe("source");
  });
  it("appends pages without moving previously displayed files", () => {
    const first = { files: [file("bun.lock"), file("z.ts")] };
    const second = { files: [file("a.ts"), file("z.ts")] };
    expect(orderPrFilePages([first, second]).map((entry) => entry.path)).toEqual([
      "z.ts",
      "bun.lock",
      "a.ts",
    ]);
  });
  it("does not resolve an unknown import to a unique basename in an unrelated directory", () => {
    const a = file("a.ts", 'import "package/z"');
    const z = file("unrelated/z.ts");
    expect(orderPrFiles([z, a])).toEqual([a, z]);
  });
});
