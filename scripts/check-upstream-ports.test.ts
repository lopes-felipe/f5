import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { UpstreamTopic } from "@t3tools/contracts";
import {
  canonicalJson,
  digestShas,
  serializeLedgerFiles,
  type RunGitSync,
  type UpstreamLedger,
} from "@t3tools/shared/upstreamPorts";
import { afterEach, describe, expect, it } from "vitest";

import { checkUpstreamPorts, normalizeRepositoryUrl } from "./check-upstream-ports.ts";
import { SEED_POLICY, SEED_RULES } from "./migrate-upstream-ledger-v7.ts";

const sha = (seed: string) => seed.padStart(40, "0");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const archive = () => {
  const shas = [sha("a1")];
  return `${JSON.stringify({
    schemaVersion: 6,
    entries: [
      { upstreamSha: sha("a1"), subject: "archived", disposition: "deferred", reason: "x" },
    ],
    intervals: [
      {
        baseSha: sha("a0"),
        targetSha: sha("a1"),
        selection: "first-parent",
        count: 1,
        digest: digestShas(shas),
        upstreamShas: shas,
      },
    ],
    legacyCoverage: { count: 0, digest: digestShas([]), upstreamShas: [] },
    legacyProvenance: [],
  })}\n`;
};

const topic = (id: string, overrides: Partial<UpstreamTopic> = {}): UpstreamTopic => ({
  id,
  createdAt: "2026-10-21T07:00:00.000Z",
  title: `Topic ${id}`,
  summary: "",
  upstreamPrs: [],
  status: "inbox",
  epoch: 1,
  ...overrides,
});

const ledger: UpstreamLedger = {
  intervals: [
    {
      schemaVersion: 7,
      interval: 1,
      baseSha: sha("a1"),
      targetSha: sha("b2"),
      selection: "first-parent",
      createdAt: "2026-10-21T07:00:00.000Z",
      count: 2,
      digest: digestShas([sha("b2"), sha("b1")]),
      commits: [
        { sha: sha("b2"), subject: "two (#2)", pr: 2, topic: "pr-2" },
        { sha: sha("b1"), subject: "one (#1)", pr: 1, topic: "pr-1" },
      ],
    },
  ],
  legacy: [],
  topics: [
    topic("pr-1"),
    topic("pr-2", {
      status: "skip",
      reasonKey: "mobile",
      reason: "Mobile app only",
      decidedBy: "rule",
      decidedAt: "2026-10-21T07:00:00.000Z",
    }),
  ],
};

function fixture(state: UpstreamLedger = ledger) {
  const root = mkdtempSync(path.join(tmpdir(), "upstream-check-"));
  directories.push(root);
  writeFileSync(
    path.join(root, "f5.json"),
    JSON.stringify({ upstream: { repository: "https://github.com/pingdotgg/t3code.git" } }),
  );
  const write = (relative: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, "upstream", relative)), { recursive: true });
    writeFileSync(path.join(root, "upstream", relative), text);
  };
  write("archive/schema6.json", archive());
  write("rules.json", canonicalJson(SEED_RULES));
  write("policy.md", SEED_POLICY);
  for (const [relative, text] of serializeLedgerFiles(state)) write(relative, text);
  return root;
}

interface FakeGitOptions {
  readonly remote?: string | null;
  readonly subjects?: Record<string, string>;
  /** `<status>\t<path>` lines; served in `-z` form. */
  readonly diff?: string;
  readonly baseHasArchive?: boolean;
  /** `f5.json` at the base ref; absent by default. */
  readonly baseProject?: string;
  readonly headMessage?: string;
}

function fakeGit(options: FakeGitOptions = {}): RunGitSync {
  const subjects: Record<string, string> = {
    [sha("b2")]: "two (#2)",
    [sha("b1")]: "one (#1)",
    [sha("a1")]: "archived",
    ...options.subjects,
  };
  return (args) => {
    const [command] = args;
    if (command === "remote") {
      if (options.remote === null) throw new Error("no remote");
      return options.remote ?? "git@github.com:pingdotgg/t3code.git";
    }
    if (command === "rev-parse") return sha("b2");
    if (command === "rev-list") return [sha("b2"), sha("b1"), sha("a1"), sha("a0")].join("\n");
    if (command === "log" && args.includes("--first-parent"))
      return [sha("b2"), sha("b1")].map((value) => `${value}\x1f${subjects[value]}`).join("\n");
    if (command === "log" && args.some((arg) => arg.startsWith("--grep")))
      return options.headMessage ?? "";
    if (command === "log" && args.at(-1) === sha("a1"))
      return `${sha("a1")}\x1f${subjects[sha("a1")]}`;
    if (command === "log") return options.headMessage ?? "";
    if (command === "diff") {
      if (!args.includes("-z")) throw new Error("diff must use -z");
      const fields = (options.diff ?? "").split("\n").filter(Boolean);
      return fields.map((line) => `${line.replace("\t", "\0")}\0`).join("");
    }
    if (command === "show") {
      if (options.baseProject === undefined) throw new Error("missing");
      return options.baseProject;
    }
    if (command === "cat-file") {
      if (options.baseHasArchive === false) throw new Error("missing");
      return "";
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

const run = (
  root: string,
  git: RunGitSync,
  extra: { requireUpstream?: boolean; baseRef?: string } = {},
) =>
  checkUpstreamPorts({
    root,
    runGit: git,
    requireUpstream: extra.requireUpstream ?? true,
    baseRef: extra.baseRef,
    today: "2026-10-21",
  });

describe("checkUpstreamPorts", () => {
  it("passes with inbox topics and reports counts", () => {
    const result = run(fixture(), fakeGit());
    expect(result.errors).toEqual([]);
    expect(result.summary).toContain("inbox 1");
    expect(result.summary).toContain("skipped 1");
    expect(result.summary).toContain(`tracked through ${sha("b2").slice(0, 12)}`);
  });

  it("counts a topic done from a trailer on HEAD", () => {
    const result = run(fixture(), fakeGit({ headMessage: "Port\n\nUpstream-Topic: pr-1\n" }));
    expect(result.summary).toContain("done 1");
  });

  it("fails provenance when an upstream subject differs", () => {
    const result = run(fixture(), fakeGit({ subjects: { [sha("b1")]: "rewritten" } }));
    expect(result.errors.join("\n")).toContain(`subject differs for ${sha("b1")}`);
  });

  it("requires the remote only when asked", () => {
    expect(run(fixture(), fakeGit({ remote: null })).errors.join("\n")).toContain("is required");
    const relaxed = run(fixture(), fakeGit({ remote: null }), { requireUpstream: false });
    expect(relaxed.errors).toEqual([]);
    expect(relaxed.warnings.join("\n")).toContain("provenance check skipped");
  });

  it("rejects a remote that points elsewhere", () => {
    expect(
      run(fixture(), fakeGit({ remote: "https://github.com/x/y.git" })).errors.join("\n"),
    ).toContain("does not match");
  });

  it("rejects edits to immutable files and mixed ledger-only PRs", () => {
    const immutable = run(
      fixture(),
      fakeGit({ diff: `M\tupstream/intervals/0001-${sha("b2").slice(0, 12)}.json` }),
      { baseRef: "origin/main" },
    );
    expect(immutable.errors.join("\n")).toContain("is immutable");
    const mixed = run(
      fixture(),
      fakeGit({ diff: "M\tupstream/topics/2026-10.json\nM\tapps/web/src/main.tsx" }),
      { baseRef: "origin/main" },
    );
    expect(mixed.errors.join("\n")).toContain("ledger-only PR");
    const migration = run(
      fixture(),
      fakeGit({
        diff: "A\tupstream/archive/schema6.json\nM\tscripts/check-upstream-ports.ts",
        baseHasArchive: false,
      }),
      { baseRef: "origin/main" },
    );
    expect(migration.errors).toEqual([]);
  });

  it("applies the rules to the base ledgerDir when a PR moves it", () => {
    const root = fixture();
    renameSync(path.join(root, "upstream"), path.join(root, "tracking"));
    writeFileSync(
      path.join(root, "f5.json"),
      JSON.stringify({
        upstream: { repository: "https://github.com/pingdotgg/t3code.git", ledgerDir: "tracking" },
      }),
    );
    const result = run(
      root,
      fakeGit({
        diff: "D\tupstream/archive/schema6.json\nM\tf5.json",
        baseProject: JSON.stringify({
          upstream: { repository: "https://github.com/pingdotgg/t3code.git" },
        }),
      }),
      { baseRef: "origin/main" },
    );
    expect(result.errors.join("\n")).toContain("upstream/archive/schema6.json is immutable");
  });

  it("reads paths Git would otherwise quote", () => {
    const result = run(
      fixture(),
      fakeGit({ diff: 'M\tupstream/intervals/0001-"odd"\tname.json' }),
      { baseRef: "origin/main" },
    );
    expect(result.errors.join("\n")).toContain('upstream/intervals/0001-"odd"\tname.json');
  });

  it("reports archive errors instead of crashing on an archive with no intervals", () => {
    const root = fixture();
    writeFileSync(
      path.join(root, "upstream/archive/schema6.json"),
      `${JSON.stringify({ ...JSON.parse(archive()), intervals: [] })}\n`,
    );
    const result = run(root, fakeGit());
    expect(result.errors.join("\n")).toContain("at least one interval");
  });

  it("warns about trailers for unknown topics or future epochs", () => {
    const result = run(
      fixture(),
      fakeGit({ headMessage: "x\n\nUpstream-Topic: pr-9\nUpstream-Topic: pr-1#3\n" }),
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings.join("\n")).toContain("unknown topic pr-9");
    expect(result.warnings.join("\n")).toContain("pr-1#3");
  });

  it("rejects hand-edited, non-canonical ledger files", () => {
    const root = fixture();
    writeFileSync(
      path.join(root, "upstream/topics/2026-10.json"),
      JSON.stringify({ schemaVersion: 7, month: "2026-10", topics: ledger.topics }),
    );
    expect(run(root, fakeGit()).errors.join("\n")).toContain("not canonical");
  });
});

describe("normalizeRepositoryUrl", () => {
  it("treats SSH and HTTPS GitHub URLs as equal", () => {
    expect(normalizeRepositoryUrl("git@github.com:pingdotgg/t3code.git")).toBe(
      normalizeRepositoryUrl("https://github.com/pingdotgg/t3code"),
    );
  });
});
