import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

interface TurboConfig {
  readonly tasks: Record<
    string,
    {
      readonly inputs?: ReadonlyArray<string>;
      readonly outputs?: ReadonlyArray<string>;
      readonly cache?: boolean;
    }
  >;
}

interface WorkspaceTsConfig {
  readonly extends?: string;
  readonly include?: ReadonlyArray<string>;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function listWorkspaces(): ReadonlyArray<{ readonly name: string; readonly dir: string }> {
  const workspaces: Array<{ name: string; dir: string }> = [];
  for (const parent of ["apps", "packages"] as const) {
    const parentDir = path.join(repoRoot, parent);
    for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(parentDir, entry.name);
      const pkgPath = path.join(dir, "package.json");
      if (!existsSync(pkgPath)) continue;
      const pkg = readJson<{ name: string }>(pkgPath);
      workspaces.push({ name: pkg.name, dir });
    }
  }
  const scriptsPkg = readJson<{ name: string }>(path.join(repoRoot, "scripts", "package.json"));
  workspaces.push({ name: scriptsPkg.name, dir: path.join(repoRoot, "scripts") });
  return workspaces;
}

function matchesTurboRootInput(relPathFromRepo: string, inputs: ReadonlyArray<string>): boolean {
  for (const rawInput of inputs) {
    if (!rawInput.startsWith("$TURBO_ROOT$/")) continue;
    const pattern = rawInput.slice("$TURBO_ROOT$/".length);
    if (pattern === relPathFromRepo) return true;
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      if (relPathFromRepo === prefix || relPathFromRepo.startsWith(`${prefix}/`)) {
        return true;
      }
    }
  }
  return false;
}

describe("turbo typecheck cache policy", () => {
  it("tracks every cross-workspace tsconfig extends and include path in turbo.json inputs", () => {
    const turbo = readJson<TurboConfig>(path.join(repoRoot, "turbo.json"));
    const defaultInputs = turbo.tasks.typecheck?.inputs ?? [];

    expect(turbo.tasks.typecheck?.cache).not.toBe(false);
    expect(turbo.tasks.typecheck?.outputs).toContain("*.tsbuildinfo");
    expect(defaultInputs).toContain("$TURBO_DEFAULT$");

    for (const workspace of listWorkspaces()) {
      const tsconfigPath = path.join(workspace.dir, "tsconfig.json");
      if (!existsSync(tsconfigPath)) continue;
      const tsconfig = readJson<WorkspaceTsConfig>(tsconfigPath);
      const taskInputs = turbo.tasks[`${workspace.name}#typecheck`]?.inputs ?? defaultInputs;

      const externalPaths: string[] = [];
      if (tsconfig.extends?.startsWith(".")) {
        externalPaths.push(tsconfig.extends);
      }
      for (const entry of tsconfig.include ?? []) {
        if (entry.startsWith("..")) {
          externalPaths.push(entry);
        }
      }

      for (const externalRef of externalPaths) {
        const resolved = path.resolve(workspace.dir, externalRef);
        const relFromRepo = path.relative(repoRoot, resolved).split(path.sep).join("/");
        expect(
          matchesTurboRootInput(relFromRepo, taskInputs),
          `${workspace.name} tsconfig references external path "${relFromRepo}" which must be covered by turbo.json typecheck inputs`,
        ).toBe(true);
      }
    }
  });
});
