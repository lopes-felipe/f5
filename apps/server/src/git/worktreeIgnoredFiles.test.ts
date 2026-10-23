import { expect, it } from "vitest";
import { blockingIgnoredEntries, type IgnoredFilesRemovalPolicy } from "./worktreeIgnoredFiles.ts";

it("keeps the conservative default node_modules exception without approving other ignored paths", () => {
  expect(
    blockingIgnoredEntries(["node_modules/", "apps/web/node_modules/", ".env", "dist/"]),
  ).toEqual([".env", "dist/"]);
});

it("requires explicit approval of every ignored path for manual removal", () => {
  const entries = ["node_modules/", "dist/", ".env"];
  expect(blockingIgnoredEntries(entries, { kind: "manual" })).toEqual(entries);
  expect(blockingIgnoredEntries(entries, { kind: "manual", approvedEntries: entries })).toEqual([]);
  expect(
    blockingIgnoredEntries([...entries, ".env.local"], {
      kind: "manual",
      approvedEntries: entries,
    }),
  ).toEqual([".env.local"]);
});

it("does not treat parent, wildcard, or similar directory names as approval", () => {
  expect(
    blockingIgnoredEntries(["dist/", "dist-private/", ".env"], {
      kind: "manual",
      approvedEntries: ["dist", "*", "../.env"],
    }),
  ).toEqual(["dist/", "dist-private/", ".env"]);
});

it("rejects newly appearing node_modules after a manual review", () => {
  expect(
    blockingIgnoredEntries([".env", "node_modules/"], {
      kind: "manual",
      approvedEntries: [".env"],
    }),
  ).toEqual(["node_modules/"]);
});

it("lets storage cleanup delete rebuildable outputs but keeps other ignored files protected", () => {
  expect(
    blockingIgnoredEntries(
      [
        "apps/web/dist/",
        ".turbo/",
        "apps/server/tsconfig.tsbuildinfo",
        "apps/desktop/native/macos/.build/",
        "node_modules/",
        ".DS_Store",
        ".env",
        "data.sqlite",
        "foo/",
        "dist-private/",
      ],
      { kind: "rebuildable" },
    ),
  ).toEqual([".env", "data.sqlite", "foo/", "dist-private/"]);
});

it("ignores approval data in protection mode and retains the node_modules exemption", () => {
  const policy = { kind: "protect", approvedEntries: [".env"] } as IgnoredFilesRemovalPolicy;
  expect(blockingIgnoredEntries([".env", "node_modules/"], policy)).toEqual([".env"]);
});

it("lets automatic cleanup delete build output but never local files", () => {
  const entries = [
    "dist/",
    "private.db",
    ".envrc",
    "node_modules/",
    ".env",
    "nested/.env.production",
  ];
  expect(
    blockingIgnoredEntries([...entries, "id_rsa", "terraform.tfstate"], { kind: "rebuildable" }),
  ).toEqual([
    "private.db",
    ".envrc",
    ".env",
    "nested/.env.production",
    "id_rsa",
    "terraform.tfstate",
  ]);
  expect(blockingIgnoredEntries(entries, { kind: "manual" })).toEqual(entries);
  expect(blockingIgnoredEntries(entries, { kind: "protect" })).toEqual(
    entries.filter((entry) => entry !== "node_modules/"),
  );
});
