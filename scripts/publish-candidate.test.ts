import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { createReleaseFixture } from "./lib/release-fixture.ts";
import { releaseComponents, type ReleaseCandidate } from "./release/release-candidate.ts";
import {
  selectReleaseCiRun,
  assertReleaseCiJobs,
  requiredReleaseCiJobs,
} from "./lib/release-qualification.ts";

const state = vi.hoisted(() => ({
  source: "a".repeat(40),
  tag: "",
  tagSource: "",
  draft: true,
  exists: false,
  assets: [] as { id?: number; name: string; size: number; digest: string | null; state: string }[],
  directories: new Map<number, string>(),
  writes: [] as string[],
  interrupt: false,
  partialInterrupt: false,
  certification: false,
  certifyAfterUpload: false,
  foreignRun: false,
  uploadService: "",
  archives: new Map<number, string>(),
  archiveDigests: new Map<number, string>(),
  rehearsalCandidate: null as ReleaseCandidate | null,
  uploadedBytes: new Map<string, Buffer>(),
  summaries: [] as string[],
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (args[0] === "release-summary.json") state.summaries.push(String(args[1]));
      else fs.writeFileSync(...args);
    },
  };
});
vi.mock("./release/release-github.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./release/release-github.ts")>();
  const release = () => ({
    id: 10,
    tag_name: state.tag,
    draft: state.draft,
    prerelease: true,
    assets: state.assets,
  });
  return {
    ...original,
    requireCi: (sha: string, profile: "all" | "windows") => {
      if (!state.rehearsalCandidate) return undefined;
      const ci = selectReleaseCiRun([fixtureRun(200, "ci.yml")], sha);
      assertReleaseCiJobs(
        [
          { name: "test", conclusion: "success" },
          { name: "CI result", conclusion: "success" },
        ],
        requiredReleaseCiJobs(
          {
            jobs: {
              test: { "runs-on": "ubuntu-latest" },
              "ci-result": { name: "CI result", needs: ["test"] },
            },
          },
          profile,
        ),
      );
      return ci;
    },
    show: (_sha: string, path: string) =>
      state.rehearsalCandidate && path.endsWith("ci.yml")
        ? "jobs:\n  test:\n    runs-on: ubuntu-latest\n  ci-result:\n    name: CI result\n    needs: [test]\n"
        : undefined,
    stableRequests: () => [],
    publisherIdentity: () => "fixture-publisher",
    releaseProfileAt: () => "all",
    acceptanceOnlyCommit: () => false,
    runs: (workflow: string) => [fixtureRun(workflow === "ci.yml" ? 200 : 100, workflow)],
    git: (args: string[]) => {
      if (args[0] === "ls-remote")
        return (state.tagSource || state.source) + "\trefs/tags/" + state.tag;
      if (args[0] === "rev-list" && args.includes("-n")) return state.tagSource || state.source;
      if (args[0] === "show") return "2026-10-30T00:00:00Z";
      return state.source;
    },
    downloadArtifact: async (artifact: Parameters<typeof original.downloadArtifact>[0]) =>
      state.uploadService
        ? original.downloadArtifact(artifact)
        : state.directories.get(artifact.id)!,
    api: (path: string) => {
      if (path.startsWith("actions/artifacts/")) {
        const id = Number(path.split("/").at(-1));
        return {
          id,
          name: basename(state.directories.get(id) ?? ""),
          digest: state.archiveDigests.get(id) ?? "sha256:" + "d".repeat(64),
          expired: false,
          workflow_run: { id: state.foreignRun ? 101 : 100, head_sha: state.source },
        };
      }
      if (path.startsWith("actions/workflows/ci.yml"))
        return { workflow_runs: [fixtureRun(200, "ci.yml")] };
      if (path.startsWith("commits/"))
        return { commit: { committer: { date: "2026-10-30T00:00:00Z" } } };
      if (path.startsWith("releases/"))
        return { ...release(), published_at: "2026-10-30T00:10:00Z" };
      throw new Error("Unexpected API call " + path);
    },
    optionalApi: () =>
      state.tag ? { object: { sha: state.tagSource || state.source } } : undefined,
    pages: () => (state.exists ? [release()] : []),
    gh: (args: string[]) => {
      state.writes.push(args.join(" "));
      if (args.includes("--slurp"))
        return JSON.stringify([
          {
            jobs: [
              { name: "test", conclusion: "success" },
              { name: "CI result", conclusion: "success" },
            ],
          },
        ]);
      if (args[0] === "api") {
        if (args.includes("DELETE")) {
          const id = Number(args.at(-1)!.split("/").at(-1));
          state.assets = state.assets.filter((a) => a.id !== id);
          return "";
        }
        if (args.includes("draft=true")) {
          state.exists = true;
          state.tag = args.find((a) => a.startsWith("tag_name="))!.slice(9);
          return JSON.stringify(release());
        }
        if (args.includes("draft=false")) {
          state.draft = false;
          return JSON.stringify(release());
        }
        state.tag = args
          .find((a) => a.startsWith("ref=refs/tags/"))!
          .slice("ref=refs/tags/".length);
        state.tagSource = args.find((a) => a.startsWith("sha="))!.slice(4);
      }
      return "";
    },
  };
});
vi.mock("./release/release-remote.ts", async (original) => {
  const remote = await original<typeof import("./release/release-remote.ts")>();
  return {
    ...remote,
    uploadReleaseAsset: async (_id: number, name: string, path: string) => {
      if (state.uploadService)
        return remote.uploadReleaseAsset(_id, name, path, async (args) => {
          const url = new URL(args[5]!);
          expect(url.hostname).toBe("uploads.github.com");
          expect(url.pathname).toBe("/repos/lopes-felipe/f5/releases/10/assets");
          const response = await fetch(
            state.uploadService + "/upload?name=" + url.searchParams.get("name"),
            {
              method: "POST",
              body: readFileSync(path),
            },
          );
          if (!response.ok) throw new Error("connection interrupted");
        });
      state.writes.push("upload " + name);
      if (state.interrupt && state.assets.length >= 2) {
        state.interrupt = false;
        if (state.partialInterrupt)
          state.assets.push({ id: 900, name, size: 0, digest: null, state: "starter" });
        throw new Error("connection interrupted");
      }
      const bytes = readFileSync(path);
      state.assets.push({
        id: state.assets.length + 1,
        name,
        size: bytes.length,
        digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
        state: "uploaded",
      });
    },
  };
});
vi.mock("./release/candidate-store.ts", () => ({
  loadCandidate: async () => state.rehearsalCandidate,
}));
vi.mock("./release/release-publication-gate.ts", () => ({ publicationGate: vi.fn() }));
vi.mock("./release/release-timing.ts", () => ({ workflowTiming: () => [] }));
vi.mock("./release/release-upgrade-proof.ts", async (original) => ({
  ...(await original<typeof import("./release/release-upgrade-proof.ts")>()),
  sameBaselines: () => true,
  upgradePlan: () => ({
    key: "100-1-" + "a".repeat(24),
    baselines: [],
    cliBaseline: "0.1.1",
    cliTargets: [],
  }),
}));
vi.mock("./lib/release-profile.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/release-profile.ts")>();
  return {
    ...original,
    fetchReleaseSummaries: () =>
      state.exists
        ? [{ tag_name: state.tag, draft: state.draft, prerelease: true, assets: state.assets }]
        : [],
  };
});
vi.mock("./lib/release-promotion.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/release-promotion.ts")>();
  return {
    ...original,
    promotionProblems: () =>
      state.certification || (state.certifyAfterUpload && state.assets.length)
        ? ["record: evidence commit is not in the tag's history"]
        : [],
  };
});
import {
  assembleCandidate,
  publishCandidate,
  verifyCandidateCertification,
  verifyPublishedCandidate,
} from "./release/publish-candidate.ts";
import { reconcileReleases } from "./reconcile-releases.ts";
function fixtureRun(id: number, workflow: string) {
  return {
    id,
    head_sha: state.source,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    run_number: id,
    path: ".github/workflows/" + workflow,
    repository: { full_name: "lopes-felipe/f5" },
    head_repository: { full_name: "lopes-felipe/f5" },
    created_at: "2026-10-30T00:00:00Z",
    run_started_at: "2026-10-30T00:00:01Z",
    updated_at: "2026-10-30T00:01:00Z",
  };
}

async function candidateFixture() {
  const fixture = createReleaseFixture();
  const root = mkdtempSync(join(tmpdir(), "f5-candidate-test-"));
  const cli = JSON.parse(readFileSync(join(fixture.dir, "f5-cli-release.json"), "utf8"));
  const candidate: ReleaseCandidate = {
    schemaVersion: 1,
    sourceSha: state.source,
    anchorSha: "b".repeat(40),
    version: fixture.version,
    kind: "beta",
    channel: "beta",
    profile: "all",
    stableIntent: null,
    runId: 100,
    runAttempt: 1,
    createdAt: "2026-10-30T10:00:00Z",
    toolchain: {
      node: "v24.13.1",
      bun: "1.3.11",
      bunWindowsArm64: "1.3.11",
      lockSha256: "c".repeat(64),
    },
    windowsBaselines: [],
    artifacts: [],
  };
  const artifacts: ReleaseCandidate["artifacts"][number][] = [];
  for (const [index, component] of releaseComponents("all").entries()) {
    const name = component + "-attempt-1",
      dir = join(root, name);
    mkdirSync(dir);
    const [, platform, arch] = component.split("-");
    if (component.startsWith("cli-")) {
      const target = component.slice(4),
        archive = "f5-" + fixture.version + "-" + target + ".tar.gz";
      copyFileSync(join(fixture.dir, archive), join(dir, archive));
      writeFileSync(
        join(dir, "f5-" + fixture.version + "-" + target + ".json"),
        JSON.stringify({
          ...cli,
          artifacts: cli.artifacts.filter((a: { target: string }) => a.target === target),
        }),
      );
    } else if (platform === "mac") {
      for (const file of readdirSync(fixture.dir).filter(
        (n) => n.startsWith("F5-") && n.includes("-" + arch + "."),
      ))
        if (!file.endsWith(".exe") && !file.endsWith(".blockmap") && !file.endsWith(".AppImage"))
          copyFileSync(join(fixture.dir, file), join(dir, file));
      const feed = parse(readFileSync(join(fixture.dir, "beta-mac.yml"), "utf8"));
      feed.files = feed.files.filter((f: { url: string }) => f.url.includes("-" + arch + "."));
      if (feed.path) {
        feed.path = feed.files[0].url;
        feed.sha512 = feed.files[0].sha512;
      }
      writeFileSync(
        join(dir, arch === "x64" ? "beta-mac-x64.yml" : "beta-mac.yml"),
        stringify(feed),
      );
    } else {
      const names =
        platform === "win"
          ? [
              "F5-" + fixture.version + "-x64.exe",
              "F5-" + fixture.version + "-x64.exe.blockmap",
              "beta.yml",
            ]
          : [
              "F5-" + fixture.version + "-x86_64.AppImage",
              "F5-" + fixture.version + "-amd64.deb",
              "beta-linux.yml",
            ];
      for (const file of names) copyFileSync(join(fixture.dir, file), join(dir, file));
    }
    state.directories.set(index + 1, dir);
    artifacts.push({
      id: index + 1,
      name,
      component,
      digest: "sha256:" + "d".repeat(64),
      receipt: {
        component,
        sourceSha: state.source,
        version: candidate.version,
        runId: 100,
        runAttempt: 1,
        ...(component.startsWith("cli-") ? { cliUpgradeBaseline: "0.0.9" } : {}),
        toolchain: {
          node: "v26.10.0",
          bun: "1.3.11",
          platform: platform === "mac" ? "darwin" : platform === "win" ? "win32" : platform!,
          arch: arch!,
          image: "test/1",
        },
        files: readdirSync(dir)
          .sort()
          .map((file) => ({
            name: file,
            size: statSync(join(dir, file)).size,
            sha256: createHash("sha256")
              .update(readFileSync(join(dir, file)))
              .digest("hex"),
          })),
      },
    });
  }
  return { candidate: { ...candidate, artifacts }, directory: join(root, "assembled") };
}
beforeEach(() => {
  state.source = "a".repeat(40);
  state.tag = "";
  state.tagSource = "";
  state.draft = true;
  state.exists = false;
  state.assets = [];
  state.directories.clear();
  state.writes = [];
  state.interrupt = false;
  state.partialInterrupt = false;
  state.certification = false;
  state.certifyAfterUpload = false;
  state.foreignRun = false;
  state.uploadService = "";
  state.rehearsalCandidate = null;
  state.archives.clear();
  state.archiveDigests.clear();
  state.uploadedBytes.clear();
  state.summaries = [];
});
it.skipIf(process.platform === "win32")(
  "hosted rehearsal downloads verified ZIPs, resumes interrupted HTTP uploads, and reconciles idempotently",
  async () => {
    const { candidate } = await candidateFixture();
    const root = mkdtempSync(join(tmpdir(), "f5-release-http-fixture-"));
    state.rehearsalCandidate = {
      ...candidate,
      artifacts: candidate.artifacts.map((artifact) => {
        const archive = join(root, artifact.id + ".zip");
        execFileSync("zip", [
          "-q",
          "-j",
          archive,
          ...artifact.receipt.files.map((f) => join(state.directories.get(artifact.id)!, f.name)),
        ]);
        const digest = "sha256:" + createHash("sha256").update(readFileSync(archive)).digest("hex");
        state.archives.set(artifact.id, archive);
        state.archiveDigests.set(artifact.id, digest);
        return { ...artifact, digest };
      }),
    };
    let downloads = 0;
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url!, "http://fixture");
        if (url.pathname.startsWith("/artifact/")) {
          downloads++;
          response.end(readFileSync(state.archives.get(Number(url.pathname.split("/").at(-1)))!));
        } else if (url.pathname === "/upload") {
          const name = url.searchParams.get("name")!;
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          if (state.interrupt && state.assets.length >= 2) {
            state.interrupt = false;
            response.writeHead(503).end("interrupted fixture upload");
            return;
          }
          if (state.uploadedBytes.has(name)) {
            response.writeHead(409).end("asset replacement forbidden");
            return;
          }
          const bytes = Buffer.concat(chunks);
          state.uploadedBytes.set(name, bytes);
          state.assets.push({
            id: state.assets.length + 1,
            name,
            size: bytes.length,
            digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
            state: "uploaded",
          });
          response.end("{}");
        } else if (url.pathname === "/atom") {
          response.end('<feed><link href="/releases/tag/' + state.tag + '"/></feed>');
        } else if (url.pathname.startsWith("/public/")) {
          const bytes = state.uploadedBytes.get(decodeURIComponent(url.pathname.slice(8)));
          if (!bytes || state.draft) response.writeHead(404).end();
          else response.end(request.method === "HEAD" ? undefined : bytes);
        } else response.writeHead(404).end();
      } catch (error) {
        response.writeHead(500).end(String(error));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    state.uploadService = "http://127.0.0.1:" + address.port;
    const actualFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL, options?: RequestInit) => {
      const url = new URL(input);
      if (url.hostname === "api.github.com" && /\/actions\/artifacts\/\d+\/zip$/.test(url.pathname))
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://fixture.invalid/artifact/" + url.pathname.split("/").at(-2),
          },
        });
      if (url.hostname === "fixture.invalid")
        return actualFetch(state.uploadService + url.pathname);
      if (url.hostname === "github.com") {
        const path = url.pathname.endsWith(".atom")
          ? "/atom"
          : "/public/" + url.pathname.split("/").at(-1);
        return actualFetch(state.uploadService + path, { method: options?.method ?? "GET" });
      }
      if (url.origin === state.uploadService) return actualFetch(input, options);
      throw new Error("External network forbidden in release rehearsal: " + url.origin);
    });
    vi.stubEnv("RELEASE_AUTOMATION_MODE", "beta");
    vi.stubEnv("GH_TOKEN", "fixture-token");
    vi.stubEnv("GITHUB_RUN_ID", "");
    vi.stubEnv("GITHUB_STEP_SUMMARY", "");
    vi.stubEnv("GITHUB_OUTPUT", "");
    try {
      state.interrupt = true;
      await expect(reconcileReleases()).rejects.toThrow("connection interrupted");
      expect(state.draft).toBe(true);
      const retained = state.assets.map((asset) => ({ ...asset }));
      expect(retained.length).toBeGreaterThanOrEqual(2);
      await reconcileReleases();
      expect(state.draft).toBe(false);
      expect(state.assets.slice(0, retained.length)).toEqual(retained);
      const completed = state.assets.map((asset) => ({ ...asset }));
      const downloaded = downloads;
      await reconcileReleases();
      expect(downloads).toBe(downloaded);
      expect(state.assets).toEqual(completed);
      expect(state.summaries.map((s) => JSON.parse(s).status)).toEqual([
        "failed",
        "published",
        "already-published",
      ]);
      expect(JSON.parse(state.summaries.at(-1)!).artifactDownloads).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  // Real ZIP subprocesses and three HTTP reconciliation cycles share the machine
  // with the workspace suites; keep this integration rehearsal bounded without
  // imposing the five-second unit-test budget on it.
  20_000,
);
describe("publisher integration with immutable platform fixtures", () => {
  it("resumes a matching draft with an interrupted starter asset without replacing uploaded bytes", async () => {
    const { candidate, directory } = await candidateFixture();
    await assembleCandidate(candidate, directory);
    state.interrupt = true;
    state.partialInterrupt = true;
    await expect(publishCandidate(candidate, directory)).rejects.toThrow("interrupted");
    const retained = state.assets.filter((a) => a.state === "uploaded").map((a) => ({ ...a }));
    await publishCandidate(candidate, directory);
    expect(state.assets.slice(0, retained.length)).toEqual(retained);
    expect(state.assets.every((a) => a.state === "uploaded")).toBe(true);
    expect(state.writes.filter((w) => w.includes("DELETE"))).toEqual([
      "api --method DELETE repos/lopes-felipe/f5/releases/assets/900",
    ]);
    expect(state.draft).toBe(false);
  });
  it.each(["public", "mismatched", "unrecognized"])(
    "never removes partial assets from a %s release",
    async (problem) => {
      const { candidate, directory } = await candidateFixture();
      await assembleCandidate(candidate, directory);
      state.interrupt = true;
      state.partialInterrupt = true;
      await expect(publishCandidate(candidate, directory)).rejects.toThrow("interrupted");
      if (problem === "public") state.draft = false;
      if (problem === "mismatched") state.assets[0]!.digest = "sha256:" + "e".repeat(64);
      if (problem === "unrecognized") state.assets.at(-1)!.name = "foreign.bin";
      const writes = state.writes.length;
      await expect(publishCandidate(candidate, directory)).rejects.toThrow();
      expect(state.writes).toHaveLength(writes);
    },
  );
  it("rejects artifacts whose API identity names another build run", async () => {
    const { candidate, directory } = await candidateFixture();
    state.foreignRun = true;
    await expect(assembleCandidate(candidate, directory)).rejects.toThrow("identity");
    expect(state.writes).toEqual([]);
  });
  it("verifies a published release after build artifacts expire without downloading them", async () => {
    const { candidate, directory } = await candidateFixture();
    await assembleCandidate(candidate, directory);
    await publishCandidate(candidate, directory);
    state.directories.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: { method?: string }) => {
        const name = decodeURIComponent(new URL(url).pathname.split("/").at(-1)!);
        if (name === "releases.atom")
          return new Response(
            '<entry><link href="https://github.com/lopes-felipe/f5/releases/tag/v' +
              candidate.version +
              '"/></entry>',
          );
        if (options?.method === "HEAD") return new Response(null, { status: 200 });
        return new Response(readFileSync(join(directory, name)));
      }),
    );
    try {
      const writes = state.writes.length;
      expect(
        await verifyPublishedCandidate(
          "v" + candidate.version,
          candidate.sourceSha,
          candidate.runId,
        ),
      ).toEqual(candidate);
      expect(state.writes).toHaveLength(writes);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("rechecks ordering after uploads before exposing a draft", async () => {
    const { candidate, directory } = await candidateFixture();
    await assembleCandidate(candidate, directory);
    let checks = 0;
    await expect(
      publishCandidate(candidate, directory, () => {
        if (++checks === 2) throw new Error("newer passing source");
      }),
    ).rejects.toThrow("newer passing");
    expect(state.draft).toBe(true);
    expect(state.writes.some((w) => w.includes("draft=false"))).toBe(false);
  });
  it("assembles exact files once and resumes an interrupted draft without replacing assets", async () => {
    const { candidate, directory } = await candidateFixture();
    await assembleCandidate(candidate, directory);
    expect(JSON.parse(readFileSync(join(directory, "f5-release-candidate.json"), "utf8"))).toEqual(
      candidate,
    );
    state.interrupt = true;
    await expect(publishCandidate(candidate, directory)).rejects.toThrow("interrupted");
    expect(state.draft).toBe(true);
    const retained = state.assets.map((a) => ({ ...a }));
    await publishCandidate(candidate, directory);
    expect(state.draft).toBe(false);
    expect(state.assets.slice(0, retained.length)).toEqual(retained);
    const writes = state.writes.length;
    await publishCandidate(candidate, directory);
    expect(state.writes).toHaveLength(writes);
    expect(state.writes.every((w) => !w.includes("--clobber"))).toBe(true);
  });
  it("rejects corrupt components before draft creation", async () => {
    const { candidate, directory } = await candidateFixture();
    const first = candidate.artifacts[0]!;
    writeFileSync(join(state.directories.get(first.id)!, first.receipt.files[0]!.name), "corrupt");
    await expect(assembleCandidate(candidate, directory)).rejects.toThrow("digest");
    expect(state.writes).toEqual([]);
  });
  it("blocks certification before reserving a tag or creating a draft", async () => {
    const { candidate, directory } = await candidateFixture();
    await assembleCandidate(candidate, directory);
    state.certification = true;
    await expect(verifyCandidateCertification(candidate)).rejects.toThrow("evidence commit");
    await expect(publishCandidate(candidate, directory)).rejects.toThrow("evidence commit");
    expect(state.tag).toBe("");
    expect(state.exists).toBe(false);
    expect(state.writes).toEqual([]);
  });
  it("blocks mismatched complete assets without changing an existing draft", async () => {
    const { candidate, directory } = await candidateFixture();
    await assembleCandidate(candidate, directory);
    state.interrupt = true;
    await expect(publishCandidate(candidate, directory)).rejects.toThrow("interrupted");
    state.assets[0]!.digest = "sha256:" + "e".repeat(64);
    const writes = state.writes.length;
    await expect(publishCandidate(candidate, directory)).rejects.toThrow("differs");
    expect(state.writes).toHaveLength(writes);
  });
  it("never repins a reserved version to a recovery candidate from another source", async () => {
    const first = await candidateFixture();
    await assembleCandidate(first.candidate, first.directory);
    state.interrupt = true;
    await expect(publishCandidate(first.candidate, first.directory)).rejects.toThrow("interrupted");
    const reserved = state.tagSource;
    const retained = state.assets.map((asset) => ({ ...asset }));
    state.source = "b".repeat(40);
    const recovery = await candidateFixture();
    await assembleCandidate(recovery.candidate, recovery.directory);
    const writes = state.writes.length;
    await expect(publishCandidate(recovery.candidate, recovery.directory)).rejects.toThrow(
      "different identity",
    );
    expect(state.tagSource).toBe(reserved);
    expect(state.assets).toEqual(retained);
    expect(state.writes).toHaveLength(writes);
  });
  it("retains the post-upload certification gate when mutable acceptance evidence changes", async () => {
    const { candidate, directory } = await candidateFixture();
    await assembleCandidate(candidate, directory);
    state.certifyAfterUpload = true;
    await expect(publishCandidate(candidate, directory)).rejects.toThrow("evidence commit");
    expect(state.exists).toBe(true);
    expect(state.draft).toBe(true);
    expect(state.writes.some((write) => write.includes("draft=false"))).toBe(false);
  });
  it("checks certification after the final gate refreshes main's evidence snapshot", async () => {
    const { candidate, directory } = await candidateFixture();
    await assembleCandidate(candidate, directory);
    let gates = 0;
    await expect(
      publishCandidate(candidate, directory, () => {
        if (++gates === 2) state.certification = true;
      }),
    ).rejects.toThrow("evidence commit");
    expect(gates).toBe(2);
    expect(state.draft).toBe(true);
    expect(state.writes.some((write) => write.includes("draft=false"))).toBe(false);
  });
  it("publishes the exact requalification key and run with the unchanged candidate provenance", async () => {
    const { candidate, directory } = await candidateFixture();
    const qualification = {
      key: "100-1-" + "a".repeat(24),
      windowsBaselines: candidate.windowsBaselines,
      cliBaseline: "0.1.1",
      requalification: { runId: 300, attempt: 2 },
    };
    await assembleCandidate(candidate, directory, qualification);
    expect(
      JSON.parse(readFileSync(join(directory, "f5-release-qualification.json"), "utf8")),
    ).toMatchObject({
      ...qualification,
      sourceSha: candidate.sourceSha,
      candidateRun: 100,
      candidateAttempt: 1,
    });
    await publishCandidate(candidate, directory);
    expect(state.assets.some((a) => a.name === "f5-release-qualification.json")).toBe(true);
  });
});
it.each(["redirect failure", "interrupted body"])(
  "retries one transient artifact transfer after %s, then stops on an integrity failure",
  async (kind) => {
    const original = await vi.importActual<typeof import("./release/release-github.ts")>(
      "./release/release-github.ts",
    );
    const redirect = () =>
      new Response(null, { status: 302, headers: { location: "https://artifact.invalid/file" } });
    const fetch = vi.fn();
    if (kind === "redirect failure")
      fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    else
      fetch.mockResolvedValueOnce(redirect()).mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(Object.assign(new Error("socket reset"), { code: "ECONNRESET" }));
            },
          }),
        ),
      );
    fetch
      .mockResolvedValueOnce(redirect())
      .mockResolvedValueOnce(new Response("corrupt zip bytes"));
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(
        original.downloadArtifact({
          id: 1,
          name: "component",
          digest: "sha256:" + "d".repeat(64),
          expired: false,
        }),
      ).rejects.toThrow("ZIP digest");
      expect(fetch).toHaveBeenCalledTimes(kind === "redirect failure" ? 3 : 4);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
it("rejects expired and corrupt artifact ZIPs before extraction or execution", async () => {
  const original = await vi.importActual<typeof import("./release/release-github.ts")>(
    "./release/release-github.ts",
  );
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://artifact.invalid/file" } }),
    )
    .mockResolvedValueOnce(new Response("corrupt zip bytes"));
  vi.stubGlobal("fetch", fetch);
  try {
    const artifact = {
      id: 1,
      name: "component",
      digest: "sha256:" + "d".repeat(64),
      expired: true,
    };
    await expect(original.downloadArtifact(artifact)).rejects.toThrow("expired");
    expect(fetch).not.toHaveBeenCalled();
    await expect(original.downloadArtifact({ ...artifact, expired: false })).rejects.toThrow(
      "ZIP digest",
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
