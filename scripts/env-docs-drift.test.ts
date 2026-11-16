import { readFileSync } from "node:fs";
import * as Path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = Path.resolve(import.meta.dirname, "..");

function documentedVariables(markdown: string): Set<string> {
  const names = new Set<string>();
  for (const line of markdown.split("\n")) {
    const match = /^\|\s*`([A-Z0-9_]+)`\s*\|/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

describe("environment variable docs", () => {
  it("documents every F5_* and T3CODE_* variable in turbo.json globalEnv", () => {
    const turbo = JSON.parse(readFileSync(Path.join(repoRoot, "turbo.json"), "utf8")) as {
      readonly globalEnv: ReadonlyArray<string>;
    };
    const documented = documentedVariables(
      readFileSync(Path.join(repoRoot, "docs/environment.md"), "utf8"),
    );
    const undocumented = turbo.globalEnv.filter(
      (name) => (name.startsWith("F5_") || name.startsWith("T3CODE_")) && !documented.has(name),
    );
    expect(undocumented).toEqual([]);
  });
});
