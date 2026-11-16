import { describe, expect, it } from "vitest";

import { compareFilePaths, compareFilePathsCaseSensitive } from "./filePathCollator";

const paths = [
  "src/file10.ts",
  "src/file2.ts",
  "src/File2.ts",
  "src/a/b.ts",
  "src/A/b.ts",
  "README.md",
  "readme.md",
  "src/ä.ts",
  "src/z.ts",
  "docs/v1.10/x.md",
  "docs/v1.9/x.md",
];

describe("file path collators", () => {
  it("order paths exactly like localeCompare with the same options", () => {
    expect(paths.toSorted(compareFilePaths)).toEqual(
      paths.toSorted((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
      ),
    );
    expect(paths.toSorted(compareFilePathsCaseSensitive)).toEqual(
      paths.toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    );
  });
});
