import type { PrHubChangedFile } from "@t3tools/contracts";

const generatedNames = new Set([
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
]);
const generatedDirs = new Set(["__snapshots__", "__generated__", "dist", "build", "vendor"]);
const testDirs = new Set(["__tests__", "tests", "test"]);
const stripExtension = (path: string) => path.replace(/\.[^/.]+$/, "");
const baseName = (path: string) => stripExtension(path.split("/").at(-1) ?? "");

export function prFileTier(path: string): "source" | "test" | "generated" {
  const segments = path.split("/");
  const name = segments.pop() ?? "";
  if (
    generatedNames.has(name) ||
    /\.(snap|min\.js|min\.css)$/.test(name) ||
    /\.generated\./.test(name) ||
    segments.some((segment) => generatedDirs.has(segment))
  )
    return "generated";
  if (/\.(test|spec)\./.test(name) || segments.some((segment) => testDirs.has(segment)))
    return "test";
  return "source";
}

/** Dependencies first, then their tests, then generated files; stable for partial paged diffs. */
export function orderPrFiles(files: readonly PrHubChangedFile[]): PrHubChangedFile[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const source = [...byPath.keys()].filter((path) => prFileTier(path) === "source").sort();
  const byModule = new Map(source.map((path) => [stripExtension(path), path]));
  const byBase = new Map<string, string | null>();
  for (const path of source) {
    const base = baseName(path);
    byBase.set(base, byBase.has(base) ? null : path);
  }
  const imports = new Map<string, Set<string>>();
  for (const path of source) {
    const dependencies = new Set<string>();
    for (const match of (byPath.get(path)?.patch ?? "").matchAll(
      /(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*["']([^"']+)["']/g,
    )) {
      const specifier = match[1]!;
      const segments = specifier.startsWith(".") ? path.split("/").slice(0, -1) : [];
      for (const part of specifier.split("/")) {
        if (part === "..") segments.pop();
        else if (part && part !== ".") segments.push(part);
      }
      const module = segments.join("/").replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
      const target =
        byModule.get(module) ?? byModule.get(module + "/index") ?? byBase.get(baseName(module));
      if (target && target !== path) dependencies.add(target);
    }
    imports.set(path, dependencies);
  }
  const visiting = new Set<string>(),
    visited = new Set<string>(),
    ordered: string[] = [];
  for (const path of source) {
    const stack = [{ path, complete: false }];
    while (stack.length) {
      const next = stack.pop()!;
      if (visited.has(next.path)) continue;
      if (next.complete) {
        visiting.delete(next.path);
        visited.add(next.path);
        ordered.push(next.path);
      } else if (!visiting.has(next.path)) {
        visiting.add(next.path);
        stack.push({ path: next.path, complete: true });
        for (const dependency of [...(imports.get(next.path) ?? [])].sort().reverse())
          stack.push({ path: dependency, complete: false });
      }
    }
  }
  const sourcePositions = new Map(ordered.map((path, index) => [baseName(path), index]));
  const tests = [...byPath.keys()]
    .filter((path) => prFileTier(path) === "test")
    .sort((left, right) => {
      const tested = (path: string) => baseName(path).replace(/\.(test|spec)$/, "");
      return (
        (sourcePositions.get(tested(left)) ?? Infinity) -
          (sourcePositions.get(tested(right)) ?? Infinity) || left.localeCompare(right)
      );
    });
  const generated = [...byPath.keys()].filter((path) => prFileTier(path) === "generated").sort();
  return [...ordered, ...tests, ...generated].map((path) => byPath.get(path)!);
}
