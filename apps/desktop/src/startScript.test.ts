import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("desktop production start", () => {
  it("builds the desktop and server bundles before launch", () => {
    const rootPackageJson = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, "../../../package.json"), "utf8"),
    ) as { readonly scripts?: Readonly<Record<string, string>> };

    expect(rootPackageJson.scripts?.["start:desktop"]).toBe(
      "bun run build:desktop && turbo run start --filter=@t3tools/desktop",
    );
  });
});
