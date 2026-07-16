import { readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const NON_PORTABLE_SCRIPT_PATTERN = /(?:^|\s)(?:rm\s+-rf|cp\s+-r|mkdir\s+-p)(?:\s|$)/;

describe("package script portability", () => {
  it("does not use POSIX-only filesystem commands", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const packagePaths = [
      "package.json",
      "scripts/package.json",
      "apps/marketing/package.json",
      "apps/server/package.json",
      "apps/web/package.json",
      "apps/desktop/package.json",
      "packages/contracts/package.json",
      "packages/effect-acp/package.json",
      "packages/shared/package.json",
    ];
    const failures: string[] = [];
    for (const packagePath of packagePaths) {
      const packageJson = JSON.parse(readFileSync(path.join(repoRoot, packagePath), "utf8")) as {
        readonly scripts?: Record<string, string>;
      };
      for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
        if (NON_PORTABLE_SCRIPT_PATTERN.test(command)) {
          failures.push(`${packagePath}#${name}: ${command}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
