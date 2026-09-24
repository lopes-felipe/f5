import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTHORITATIVE_REPOSITORY } from "./upstream-port-history.ts";
import { parseLedger } from "./upstream-port-validation.ts";
import { withLedgerLock } from "./upstream-port-files.ts";
import { ROOT, SCRIPT, repository, sha } from "./upstream-port-test-fixtures.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(mode: "normal" | "block-fetch" | "edit-during-validation" = "normal") {
  // Identical initial commits, with three additional commits available to fetch.
  const upstream = repository(7);
  const local = repository(4);
  directories.push(upstream.directory, local.directory);
  const ready = path.join(local.directory, "fetch-started");
  const preload = path.join(local.directory, "local-fetch.mjs");
  // A repository-wide insteadOf setting also rewrites `remote get-url`, so the
  // production provenance gate would correctly reject that remote. Restrict the
  // test transport override to the real fetch invocation; every Git read and
  // validation still runs unchanged, and no production test bypass is added.
  writeFileSync(
    preload,
    `
    import cp from "node:child_process";
    import { writeFileSync } from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const original = cp.execFileSync;
    let logs = 0;
    cp.execFileSync = (file, args, options) => {
      if (file === "git" && args[0] === "fetch") {
        if (${JSON.stringify(mode)} === "block-fetch") {
          writeFileSync(${JSON.stringify(ready)}, "fetch started");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        return original(file, ["-c", ${JSON.stringify(`url.${pathToFileURL(upstream.directory).href}/.insteadOf=${AUTHORITATIVE_REPOSITORY}`)}, ...args], options);
      }
      const result = original(file, args, options);
      if (file === "git" && args[0] === "log" && ++logs === 2 && ${JSON.stringify(mode)} === "edit-during-validation") {
        writeFileSync(${JSON.stringify(local.file)}, "external edit\\n");
      }
      return result;
    };
    syncBuiltinESMExports();
  `,
  );
  const plan = {
    schemaVersion: 1,
    baseSha: upstream.commits.at(-1)!.sha,
    targetSha: upstream.commits[0]!.sha,
    entries: upstream.commits.slice(0, -1).map((c) => ({
      upstreamSha: c.sha,
      classification: "planned:2",
      reason: "Deferred after manual performance assessment; approved for Phase 2.",
      reviewStatus: "reviewed",
    })),
  };
  const planFile = path.join(local.directory, "plan.json");
  writeFileSync(planFile, JSON.stringify(plan));
  const env = {
    ...process.env,
    F5_UPSTREAM_PORTS_ROOT: local.directory,
    F5_UPSTREAM_PORTS_LEDGER_PATH: local.file,
    F5_REQUIRE_UPSTREAM: "1",
  };
  const args = (script: string, argv: string[]) => [
    "--import",
    pathToFileURL(preload).href,
    script,
    ...argv,
  ];
  const run = (script: string, argv: string[]) =>
    spawnSync(process.execPath, args(script, argv), { env, encoding: "utf8" });
  const classifyScript = path.join(ROOT, "scripts/generate-upstream-gap.ts");
  return {
    local,
    upstream,
    ready,
    plan,
    planFile,
    env,
    args,
    run,
    refresh: (pin?: string) => run(SCRIPT, ["--refresh", ...(pin ? ["--head", pin] : [])]),
    classify: () => run(classifyScript, [planFile]),
  };
}
describe("ledger writing commands", () => {
  it("fetches and appends pending commits, classifies them, and preserves repeated/older pins", () => {
    const f = fixture();
    const before = parseLedger(readFileSync(f.local.file, "utf8"));
    const refresh = f.refresh();
    expect(refresh.status, refresh.stderr).toBe(0);
    const discovered = parseLedger(readFileSync(f.local.file, "utf8"));
    expect(discovered.intervals).toHaveLength(2);
    expect(discovered.intervals[1]?.count).toBe(3);
    expect(discovered.entries.filter((e) => e.reviewStatus === "pending")).toHaveLength(3);
    for (const record of before.entries)
      expect(discovered.entries.find((e) => e.upstreamSha === record.upstreamSha)).toEqual(record);
    expect(f.run(SCRIPT, []).stderr).toContain("requires review");
    const classified = f.classify();
    expect(classified.status, classified.stderr).toBe(0);
    const text = readFileSync(f.local.file, "utf8");
    expect(
      parseLedger(text).entries.every(
        (e) => e.reviewStatus === "reviewed" && e.plannedWorkstream === "2",
      ),
    ).toBe(true);
    expect(f.run(SCRIPT, []).status).toBe(0);
    expect(f.classify().status).toBe(0);
    expect(f.refresh().status).toBe(0);
    expect(f.refresh(f.local.commits[0]!.sha).status).toBe(0);
    expect(readFileSync(f.local.file, "utf8")).toBe(text);
  });
  it("both writers refuse an already-held lock", () => {
    const f = fixture();
    const before = readFileSync(f.local.file, "utf8");
    withLedgerLock(f.local.file, () => {
      for (const result of [f.refresh(), f.classify()]) {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`${f.local.file}.lock`);
      }
    });
    expect(readFileSync(f.local.file, "utf8")).toBe(before);
  });
  it("invalid classification evidence fails the final candidate check without publishing", () => {
    const f = fixture();
    expect(f.refresh().status).toBe(0);
    const before = readFileSync(f.local.file, "utf8");
    writeFileSync(
      f.planFile,
      JSON.stringify({
        ...f.plan,
        entries: f.plan.entries.map((e) => ({
          ...e,
          classification: "equivalent:missing-file.ts:1",
          f5Shas: [sha(999)],
        })),
      }),
    );
    const result = f.classify();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("evidence file does not exist");
    expect(readFileSync(f.local.file, "utf8")).toBe(before);
    expect(existsSync(`${f.local.file}.lock`)).toBe(false);
  });
  it.each(["refresh", "classify"] as const)(
    "%s preserves an edit made after its initial read",
    (operation) => {
      const f = fixture("edit-during-validation");
      if (operation === "classify") {
        // Classification needs pre-existing coverage; use the fixture's complete history.
        writeFileSync(f.local.file, JSON.stringify(f.upstream.ledger));
        f.local.git(["fetch", f.upstream.directory, "refs/heads/main:refs/remotes/upstream/main"]);
      }
      const result = operation === "refresh" ? f.refresh() : f.classify();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ledger changed during publication");
      expect(readFileSync(f.local.file, "utf8")).toBe("external edit\n");
      expect(existsSync(`${f.local.file}.lock`)).toBe(false);
    },
  );
  it("an interrupted fetch leaves no ledger lock or changes", async () => {
    const f = fixture("block-fetch");
    const before = readFileSync(f.local.file, "utf8");
    const child = spawn(process.execPath, f.args(SCRIPT, ["--refresh"]), {
      env: f.env,
      stdio: "ignore",
    });
    const closed = once(child, "close");
    try {
      await vi.waitFor(() => expect(existsSync(f.ready)).toBe(true), { timeout: 5000 });
      expect(existsSync(`${f.local.file}.lock`)).toBe(false);
    } finally {
      child.kill("SIGTERM");
      await closed;
    }
    expect(readFileSync(f.local.file, "utf8")).toBe(before);
    expect(existsSync(`${f.local.file}.lock`)).toBe(false);
  });
});
