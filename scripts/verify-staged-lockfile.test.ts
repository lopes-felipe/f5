import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import rootPackageJson from "../package.json" with { type: "json" };
import {
  seedStagedLockfile,
  verifyAppliedPatches,
  verifyStagedLockfile,
} from "./verify-staged-lockfile.ts";
const lock = (packages: Record<string, unknown>) => JSON.stringify({ packages });
it("checks version and integrity including duplicate and optional versions", () => {
  const root = lock({
    a: ["a@1.0.0", "", {}, "sha512-first"],
    "a/a": ["a@2.0.0", "", {}, "sha512-second"],
    optional: ["native@1.0.0", "", { os: "darwin" }, "sha512-native"],
  });
  expect(() =>
    verifyStagedLockfile(
      root,
      lock({
        a: ["a@2.0.0", "", {}, "sha512-second"],
        native: ["native@1.0.0", "", {}, "sha512-native"],
      }),
    ),
  ).not.toThrow();
  expect(() =>
    verifyStagedLockfile(root, lock({ a: ["a@3.0.0", "", {}, "sha512-first"] })),
  ).toThrow();
  expect(() =>
    verifyStagedLockfile(root, lock({ a: ["a@1.0.0", "", {}, "sha512-changed"] })),
  ).toThrow();
});
it("seeds a single-package lockfile from the root lock without workspace packages", () => {
  const root = JSON.stringify({
    lockfileVersion: 1,
    configVersion: 1,
    workspaces: { "": { name: "monorepo" }, "apps/server": { name: "t3" } },
    overrides: { vite: "^8.0.0" },
    catalog: { effect: "1.0.0" },
    packages: {
      a: ["a@1.0.0", "", {}, "sha512-a"],
      "b/a": ["a@2.0.0", "", {}, "sha512-a2"],
      t3: ["t3@workspace:apps/server"],
    },
  });
  const seeded = JSON.parse(
    seedStagedLockfile(root, {
      name: "f5-desktop",
      dependencies: { a: "^1.0.0" },
      devDependencies: { electron: "40.6.0" },
      overrides: { vite: "^8.0.0" },
    }),
  );
  expect(seeded).toEqual({
    lockfileVersion: 1,
    configVersion: 1,
    workspaces: {
      "": {
        name: "f5-desktop",
        dependencies: { a: "^1.0.0" },
        devDependencies: { electron: "40.6.0" },
      },
    },
    overrides: { vite: "^8.0.0" },
    packages: {
      a: ["a@1.0.0", "", {}, "sha512-a"],
      "b/a": ["a@2.0.0", "", {}, "sha512-a2"],
    },
  });
  expect(() => verifyStagedLockfile(root, JSON.stringify(seeded))).not.toThrow();
});
it("carries patched dependencies into the seeded lockfile", () => {
  const patchedDependencies = { "@s/pkg@https://pkg.pr.new/@s/pkg@abc": "patches/p.patch" };
  const seeded = JSON.parse(
    seedStagedLockfile(JSON.stringify({ lockfileVersion: 1, packages: {} }), {
      name: "f5-desktop",
      dependencies: {},
      patchedDependencies,
    }),
  );
  expect(seeded.patchedDependencies).toEqual(patchedDependencies);
});
it("rejects a stage whose patched package is still stock", () => {
  const files: Record<string, string> = {
    [join("/r", "patches/p.patch")]:
      "--- a/dist/x.js\n+++ b/dist/x.js\n@@ -1 +1,2 @@\n stock();\n+  guard();\n",
    [join("/r", "node_modules/@s/pkg/dist/x.js")]: "stock();\n",
  };
  const read = (path: string) => {
    if (!(path in files)) throw new Error(`ENOENT ${path}`);
    return files[path]!;
  };
  const patched = { "@s/pkg@https://pkg.pr.new/@s/pkg@abc": "patches/p.patch" };
  expect(() => verifyAppliedPatches("/r", patched, read)).toThrow("is not applied");
  files[join("/r", "node_modules/@s/pkg/dist/x.js")] = "stock();\n  guard();\n";
  expect(() => verifyAppliedPatches("/r", patched, read)).not.toThrow();
  expect(() => verifyAppliedPatches("/r", { "@s/missing@1.0.0": "patches/p.patch" }, read)).toThrow(
    "ENOENT",
  );
});
it("keys every repository patch to a locked package and an existing patch file", () => {
  // A dependency bump changes the locked specifier; the stale key then silently
  // stops applying. See patches/README.md for regenerating a patch.
  const root = join(import.meta.dirname, "..");
  const locked = new Set(
    Object.values(
      (
        ts.parseConfigFileTextToJson("bun.lock", readFileSync(join(root, "bun.lock"), "utf8"))
          .config as { packages: Record<string, unknown[]> }
      ).packages,
    ).map((entry) => entry[0]),
  );
  const patched = Object.entries(rootPackageJson.patchedDependencies);
  expect(patched.length).toBeGreaterThan(0);
  for (const [specifier, file] of patched) {
    expect(locked.has(specifier), specifier).toBe(true);
    expect(existsSync(join(root, file)), file).toBe(true);
  }
});
