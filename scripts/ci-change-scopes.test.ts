import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as Path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Pull requests skip jobs whose checks cannot read the changed app (see
// .github/actions/changes). That is only sound while the code those jobs execute
// imports nothing from the skipped app, which these tests hold.

const repoRoot = Path.resolve(import.meta.dirname, "..");
const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const ignoredDirectories = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  "dist-native",
  "target",
  "public",
  ".turbo",
  ".playwright",
  ".astro",
]);
const packageRoots: Record<string, string> = {
  "@t3tools/web": "apps/web",
  "@t3tools/marketing": "apps/marketing",
  t3: "apps/server",
};

const posix = (path: string) => path.split(Path.sep).join("/");

function sourceFiles(root: string): string[] {
  const directory = Path.join(repoRoot, root);
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = Path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) visit(path);
      } else if (
        sourceExtensions.includes(Path.extname(entry.name)) &&
        // This file's own fixtures spell out cross-app imports.
        path !== import.meta.filename
      ) {
        files.push(path);
      }
    }
  };
  visit(directory);
  return files;
}

/** Static, dynamic and CommonJS specifiers; query suffixes such as `?raw` are dropped. */
function specifiers(source: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"'\n]+)["']/g;
  return [...source.matchAll(pattern)].map((match) => match[1]!.replace(/[?#].*$/, ""));
}

/** Repo-relative path a specifier points at, or null for external packages. */
function target(file: string, specifier: string): string | null {
  if (specifier.startsWith(".")) {
    const resolved = Path.resolve(Path.dirname(file), specifier);
    const candidates = [
      resolved,
      ...sourceExtensions.map((extension) => resolved + extension),
      ...sourceExtensions.map((extension) => Path.join(resolved, "index" + extension)),
    ];
    const existing = candidates.find((path) => existsSync(path) && statSync(path).isFile());
    return posix(Path.relative(repoRoot, existing ?? resolved));
  }
  for (const [name, root] of Object.entries(packageRoots))
    if (specifier === name || specifier.startsWith(name + "/")) return root + "/";
  return null;
}

/** Every import from `roots` that lands inside one of the `apps`, as `importer -> target`. */
function crossings(roots: readonly string[], apps: readonly string[]) {
  const found: { importer: string; target: string }[] = [];
  for (const file of roots.flatMap(sourceFiles)) {
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      const path = target(file, specifier);
      if (path && apps.some((app) => path === app + "/" || path.startsWith(app + "/")))
        found.push({ importer: posix(Path.relative(repoRoot, file)), target: path });
    }
  }
  return found;
}

const filters = parse(
  (
    parse(readFileSync(Path.join(repoRoot, ".github/actions/changes/action.yml"), "utf8")) as {
      runs: { steps: { with?: { filters?: string } }[] };
    }
  ).runs.steps[0]!.with!.filters!,
) as Record<string, string[]>;

describe("CI change scopes", () => {
  it("keeps the code run by web-unaffected jobs free of web and marketing imports", () => {
    // server-unit and macos-profiles run server, desktop, shared package and script code.
    expect(
      crossings(
        ["apps/server", "apps/desktop", "packages", "scripts"],
        ["apps/web", "apps/marketing"],
      ),
    ).toEqual([]);
  });

  it("lists every server source the browser suite reads in server_read_by_web", () => {
    const declared = filters.server_read_by_web!;
    for (const path of declared) {
      expect(path, "server_read_by_web holds literal files").not.toMatch(/[*?!{}[\]]/);
      expect(existsSync(Path.join(repoRoot, path)), path).toBe(true);
    }
    const imported = new Set(
      crossings(["apps/web", "packages"], ["apps/server"]).map((crossing) => crossing.target),
    );
    // A listed server file may itself import other server files; those count as read too.
    const pending = [...imported];
    while (pending.length) {
      const path = pending.pop()!;
      const file = Path.join(repoRoot, path);
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      for (const specifier of specifiers(readFileSync(file, "utf8"))) {
        const next = target(file, specifier);
        if (next?.startsWith("apps/server/") && !imported.has(next)) {
          imported.add(next);
          pending.push(next);
        }
      }
    }
    expect([...imported].toSorted()).toEqual(declared.toSorted());
  });

  it("recognises relative, package and dynamic imports", () => {
    const file = Path.join(repoRoot, "apps/web/test/example.ts");
    expect(
      specifiers(
        [
          'import { a } from "../../server/src/assetHttp";',
          'export * from "t3/src/main";',
          'const b = await import("@t3tools/web/src/x?raw");',
          'import "./local";',
          'const c = require("node:fs");',
        ].join("\n"),
      ).map((specifier) => target(file, specifier)),
    ).toEqual([
      "apps/server/src/assetHttp.ts",
      "apps/server/",
      "apps/web/",
      "apps/web/test/local",
      null,
    ]);
  });
});
