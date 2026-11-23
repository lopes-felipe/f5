import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parse } from "yaml";
import { selectVmBackendManifest } from "./select-vm-backend-manifest.ts";

let dir: string;
beforeEach(() => {
  dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-vm-manifest-"));
});
afterEach(() => {
  FS.rmSync(dir, { recursive: true, force: true });
});

const manifest = (attempt: number, content = "{}") => {
  const file = Path.join(
    dir,
    `vm-backend-manifest-attempt-${attempt}`,
    "f5-1.2.3-linux-arm64.json",
  );
  FS.mkdirSync(Path.dirname(file), { recursive: true });
  FS.writeFileSync(file, content);
  return file;
};

it("pins the latest attempt's manifest at or before this run attempt", () => {
  manifest(1);
  const second = manifest(2);
  manifest(4);
  FS.mkdirSync(Path.join(dir, "unrelated-attempt-3"));
  expect(selectVmBackendManifest(dir, 3, "1.2.3")).toBe(Path.resolve(second));
});

it("refuses when no attempt uploaded a manifest, or the latest is empty", () => {
  expect(() => selectVmBackendManifest(dir, 1, "1.2.3")).toThrow(/No Linux VM backend manifest/);
  manifest(1, "");
  expect(() => selectVmBackendManifest(dir, 1, "1.2.3")).toThrow(/missing or empty/);
  expect(() => selectVmBackendManifest(dir, 1, "9.9.9")).toThrow(/missing or empty/);
});

const workflow = (name: string) =>
  parse(FS.readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));

it("uploads each attempt's manifest before its receipt, so the pin and the release agree", () => {
  const steps: Array<{ with?: { name?: string } }> = workflow("release-cli.yml").jobs.archive.steps;
  const upload = (prefix: string) =>
    steps.findIndex((step) => step.with?.name?.startsWith(prefix) ?? false);
  const manifestStep = upload("vm-backend-manifest-attempt-");
  const receiptStep = upload("receipt-cli-");
  expect(manifestStep).toBeGreaterThan(-1);
  expect(manifestStep).toBeLessThan(receiptStep);
});

it("makes macOS packaging wait only for the linux-arm64 archive it pins", () => {
  const release = workflow("release.yml");
  expect(release.jobs["mac-desktop"].needs).toEqual(["preflight", "cli-linux-arm64"]);
  expect(release.jobs["cli-linux-arm64"].with.target).toBe("linux-arm64");
  expect(
    release.jobs.cli.strategy.matrix.include.map((leg: { target: string }) => leg.target),
  ).not.toContain("linux-arm64");
  expect(release.jobs.candidate.needs).toEqual(expect.arrayContaining(["cli", "cli-linux-arm64"]));
  expect(release.jobs.candidate.if).toContain("needs.cli-linux-arm64.result == 'success'");
  const desktop = workflow("release-desktop.yml").jobs.package.steps;
  expect(
    desktop.some((step: { run?: string }) =>
      step.run?.includes("scripts/select-vm-backend-manifest.ts"),
    ),
  ).toBe(true);
});
