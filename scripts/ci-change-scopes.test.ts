import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Pull requests skip jobs whose checks cannot read the changed app (see
// .github/actions/changes). That is only sound while the code those jobs execute
// reads nothing from the skipped app, which these tests hold.

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

/**
 * Everything in a source file that can name another file:
 * - module specifiers of static, dynamic and CommonJS imports, of functions made by
 *   `createRequire` (any `…require…(` call) and of Vitest's mock helpers;
 * - every string literal that is a relative path, which covers
 *   `new URL("../x", import.meta.url)`, `import.meta.glob`, `importActual` and
 *   paths joined onto `import.meta.dirname`.
 * A relative literal that is not a file reference resolves to nothing and is ignored
 * by the callers. Query suffixes such as `?raw` are dropped.
 */
function references(source: string): string[] {
  const modules =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\b\w*[rR]equire\w*\s*\(\s*|\b(?:importActual|importOriginal|mock|doMock|unmock)\s*(?:<[^<>()]*>)?\s*\(\s*)["'`]([^"'`\n$]+)["'`]/g;
  const relative = /["'`](\.{1,2}\/[^"'`\n$]*)["'`]/g;
  return [
    ...new Set(
      [...source.matchAll(modules), ...source.matchAll(relative)].map((match) =>
        match[1]!.replace(/[?#].*$/, ""),
      ),
    ),
  ];
}

/** File walking and reference resolution for one checkout; tests use a fixture tree. */
function scanner(root: string, self?: string) {
  const relativeTo = (path: string) => posix(Path.relative(root, path));

  function sourceFiles(directoryOrFile: string, skip: (path: string) => boolean = () => false) {
    const start = Path.join(root, directoryOrFile);
    if (!existsSync(start)) return [];
    if (statSync(start).isFile()) return [start];
    const files: string[] = [];
    const visit = (current: string) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = Path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name) && !skip(relativeTo(path) + "/")) visit(path);
        } else if (
          sourceExtensions.includes(Path.extname(entry.name)) &&
          // This file's own fixtures spell out cross-app references.
          path !== self &&
          !skip(relativeTo(path))
        ) {
          files.push(path);
        }
      }
    };
    visit(start);
    return files;
  }

  /** Repo-relative path a reference points at, or null for external packages. */
  function target(file: string, reference: string): string | null {
    if (reference.startsWith(".")) {
      const resolved = Path.resolve(Path.dirname(file), reference);
      const candidates = [
        resolved,
        ...sourceExtensions.map((extension) => resolved + extension),
        ...sourceExtensions.map((extension) => Path.join(resolved, "index" + extension)),
      ];
      const existing = candidates.find((path) => existsSync(path) && statSync(path).isFile());
      return relativeTo(existing ?? resolved);
    }
    for (const [name, packageRoot] of Object.entries(packageRoots))
      if (reference === name || reference.startsWith(name + "/")) return packageRoot + "/";
    return null;
  }

  const targets = (file: string) =>
    references(readFileSync(file, "utf8")).flatMap((reference) => target(file, reference) ?? []);

  const inside = (path: string, apps: readonly string[]) =>
    apps.some((app) => path === app || path.startsWith(app + "/"));

  /** Every reference from `files` that lands inside one of the `apps`. */
  function crossings(files: readonly string[], apps: readonly string[]) {
    const found = new Map<string, { importer: string; target: string }>();
    for (const file of files)
      for (const path of targets(file))
        if (inside(path, apps)) {
          const crossing = { importer: relativeTo(file), target: path.replace(/\/$/, "") };
          found.set(crossing.importer + " -> " + crossing.target, crossing);
        }
    return [...found.values()].toSorted((a, b) =>
      (a.importer + a.target).localeCompare(b.importer + b.target),
    );
  }

  /** Repo-relative source files reachable from `entries` through local references. */
  function reachable(entries: readonly string[]): Set<string> {
    const seen = new Set(entries);
    const pending = [...entries];
    while (pending.length) {
      const file = pending.pop()!;
      for (const path of targets(file)) {
        const next = Path.join(root, path);
        if (
          seen.has(next) ||
          !sourceExtensions.includes(Path.extname(next)) ||
          !existsSync(next) ||
          !statSync(next).isFile()
        )
          continue;
        seen.add(next);
        pending.push(next);
      }
    }
    return new Set([...seen].map(relativeTo));
  }

  return { sourceFiles, target, crossings, reachable };
}

const repo = scanner(repoRoot, import.meta.filename);

const filters = parse(
  (
    parse(readFileSync(Path.join(repoRoot, ".github/actions/changes/action.yml"), "utf8")) as {
      runs: { steps: { with?: { filters?: string } }[] };
    }
  ).runs.steps[0]!.with!.filters!,
) as Record<string, string[]>;

/** A throwaway checkout layout: repo-relative path to file content. */
function withFixture<T>(files: Record<string, string>, use: (root: string) => T): T {
  const root = mkdtempSync(Path.join(tmpdir(), "f5-ci-change-scopes-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(Path.dirname(Path.join(root, path)), { recursive: true });
      writeFileSync(Path.join(root, path), content);
    }
    return use(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("CI change scopes", () => {
  // `server-unit` runs `vitest run src` in apps/server; `macos-profiles` runs server
  // and desktop tests, shared package tests and build scripts. Two places under these
  // roots only run in the always-on `test` job and are left out: the server's
  // `integration/` suites and the script package's own tests.
  const webUnaffectedFiles = () =>
    [
      ...repo.sourceFiles("apps/server", (path) => path === "apps/server/integration/"),
      ...repo.sourceFiles("apps/desktop"),
      ...repo.sourceFiles("packages"),
      ...repo.sourceFiles("scripts", (path) => /\.test\.[cm]?[jt]sx?$/.test(path)),
      ...repo.sourceFiles("vitest.config.ts"),
    ] satisfies string[];

  // References into the web app that the skipped jobs can reach but do not depend on.
  // Each needs a reason a web-only change cannot alter the outcome of those jobs.
  const allowedWebReferences: { importer: string; target: string; reason: string }[] = [
    {
      importer: "apps/server/src/config.ts",
      target: "apps/web/dist",
      reason:
        "Runtime lookup of the built client. Unit jobs never build the web app, and the " +
        "bundle is exercised by the always-on test, desktop and windows-build jobs.",
    },
    {
      importer: "scripts/install-browser.ts",
      target: "apps/web/package.json",
      reason:
        "Reads the Playwright version to install a browser for web tests. Only " +
        "`test:browser:install` runs it, which no skipped job calls.",
    },
  ];

  it("keeps the code run by web-unaffected jobs free of web and marketing references", () => {
    expect(repo.crossings(webUnaffectedFiles(), ["apps/web", "apps/marketing"])).toEqual(
      allowedWebReferences
        .map(({ importer, target }) => ({ importer, target }))
        .toSorted((a, b) => (a.importer + a.target).localeCompare(b.importer + b.target)),
    );
    for (const allowed of allowedWebReferences) expect(allowed.reason).not.toBe("");
  });

  it("still sees the server's always-on integration reference into the web app", () => {
    // Proof that the scan matches the `new URL(…, import.meta.url)` idiom on real code:
    // this crossing exists today and is excluded above only by its directory.
    expect(
      repo.crossings(repo.sourceFiles("apps/server/integration"), ["apps/web", "apps/marketing"]),
    ).toContainEqual({
      importer: "apps/server/integration/chaos/client.ts",
      target: "apps/web/src/test/chaosClient.ts",
    });
  });

  it("lists every server source the browser suite reads in server_read_by_web", () => {
    const declared = filters.server_read_by_web!;
    for (const path of declared) {
      expect(path, "server_read_by_web holds literal files").not.toMatch(/[*?!{}[\]]/);
      expect(existsSync(Path.join(repoRoot, path)), path).toBe(true);
    }
    // Follow local references from the web app and the shared packages it imports by
    // name, through any directory they lead to (the browser config loads script
    // helpers), and on through the server files they reach.
    const read = repo.reachable([...repo.sourceFiles("apps/web"), ...repo.sourceFiles("packages")]);
    expect([...read].filter((path) => path.startsWith("apps/server/")).toSorted()).toEqual(
      declared.toSorted(),
    );
  });

  it("follows a web import through a script helper into the server", () => {
    withFixture(
      {
        "apps/web/vitest.browser.config.ts": 'import { reports } from "../../scripts/lib/reports";',
        "scripts/lib/reports.ts": 'export { limits } from "../../apps/server/src/limits.ts";',
        "apps/server/src/limits.ts": 'export * from "./shared";\nimport "node:fs";',
        "apps/server/src/shared.ts": "export const limits = 1;",
        "apps/server/src/unrelated.ts": "export const unrelated = 1;",
      },
      (root) => {
        const fixture = scanner(root);
        expect(
          [...fixture.reachable(fixture.sourceFiles("apps/web"))]
            .filter((path) => path.startsWith("apps/server/"))
            .toSorted(),
        ).toEqual(["apps/server/src/limits.ts", "apps/server/src/shared.ts"]);
      },
    );
  });

  it("finds references that are not import statements", () => {
    withFixture(
      {
        "apps/server/src/url.ts": [
          "export const client = fileURLToPath(",
          '  new URL("../../web/src/test/client.ts", import.meta.url),',
          ");",
        ].join("\n"),
        "apps/server/src/mocks.test.ts": [
          'vi.mock("../../web/src/store", () => ({}));',
          'const actual = await vi.importActual<typeof Store>("@t3tools/web/src/store");',
        ].join("\n"),
        "apps/server/src/glob.ts": 'const pages = import.meta.glob("../../marketing/src/*.astro");',
        "apps/server/src/require.ts": [
          "const requireWeb = createRequire(import.meta.url);",
          'const manifest = requireWeb("@t3tools/web/package.json");',
        ].join("\n"),
        "apps/server/src/dirname.ts": "const dist = join(import.meta.dirname, `../../web/dist`);",
        "apps/server/src/local.ts": 'import "./url";\nconst label = "../not/a/file";',
        "apps/web/src/test/client.ts": "",
        "apps/web/src/store.ts": "",
      },
      (root) => {
        const fixture = scanner(root);
        expect(
          fixture.crossings(fixture.sourceFiles("apps/server"), ["apps/web", "apps/marketing"]),
        ).toEqual([
          { importer: "apps/server/src/dirname.ts", target: "apps/web/dist" },
          { importer: "apps/server/src/glob.ts", target: "apps/marketing/src/*.astro" },
          { importer: "apps/server/src/mocks.test.ts", target: "apps/web" },
          { importer: "apps/server/src/mocks.test.ts", target: "apps/web/src/store.ts" },
          { importer: "apps/server/src/require.ts", target: "apps/web" },
          { importer: "apps/server/src/url.ts", target: "apps/web/src/test/client.ts" },
        ]);
      },
    );
  });

  it("resolves relative, package and dynamic imports", () => {
    const file = Path.join(repoRoot, "apps/web/test/example.ts");
    expect(
      references(
        [
          'import { a } from "../../server/src/assetHttp";',
          'export * from "t3/src/main";',
          'const b = await import("@t3tools/web/src/x?raw");',
          'import "./local";',
          'const c = require("node:fs");',
        ].join("\n"),
      ).map((reference) => repo.target(file, reference)),
    ).toEqual([
      "apps/server/src/assetHttp.ts",
      "apps/server/",
      "apps/web/",
      "apps/web/test/local",
      null,
    ]);
  });
});
