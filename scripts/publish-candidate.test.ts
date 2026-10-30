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
import { parse, stringify } from "yaml";
import { createReleaseFixture } from "./lib/release-fixture.ts";
import { releaseComponents, type ReleaseCandidate } from "./release/release-candidate.ts";

const state = vi.hoisted(() => ({
  source: "a".repeat(40),
  tag: "",
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
}));
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
    requireCi: vi.fn(),
    show: () => undefined,
    git: (args: string[]) =>
      args[0] === "ls-remote" ? state.source + "\trefs/tags/" + state.tag : state.source,
    api: (path: string) => {
      if (path.startsWith("actions/artifacts/")) {
        const id = Number(path.split("/").at(-1));
        return {
          id,
          name: basename(state.directories.get(id) ?? ""),
          digest: "sha256:" + "d".repeat(64),
          expired: false,
          workflow_run: { id: state.foreignRun ? 101 : 100, head_sha: state.source },
        };
      }
      if (path.startsWith("releases/")) return release();
      throw new Error("Unexpected API call " + path);
    },
    optionalApi: () => (state.tag ? { object: { sha: state.source } } : undefined),
    pages: () => (state.exists ? [release()] : []),
    downloadArtifact: async (a: { id: number }) => state.directories.get(a.id)!,
    gh: (args: string[]) => {
      state.writes.push(args.join(" "));
      if (args[0] === "api") {
        if (args.includes("DELETE")) {
          const id = Number(args.at(-1)!.split("/").at(-1));
          state.assets = state.assets.filter((a) => a.id !== id);
          return "";
        }
        state.tag = args
          .find((a) => a.startsWith("ref=refs/tags/"))!
          .slice("ref=refs/tags/".length);
      }
      if (args[1] === "create") {
        state.exists = true;
        state.tag = args[2]!;
        state.draft = true;
      }
      if (args[1] === "upload") {
        if (state.interrupt && state.assets.length === 2) {
          state.interrupt = false;
          if (state.partialInterrupt)
            state.assets.push({
              id: 900,
              name: basename(args[3]!),
              size: 0,
              digest: null,
              state: "starter",
            });
          throw new Error("connection interrupted");
        }
        const file = args[3]!,
          bytes = readFileSync(file);
        state.assets.push({
          name: basename(file),
          size: bytes.length,
          digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
          state: "uploaded",
        });
      }
      if (args[1] === "edit") state.draft = false;
      return "";
    },
  };
});
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
        ? ["Missing exact artifact acceptance"]
        : [],
  };
});
import {
  assembleCandidate,
  publishCandidate,
  verifyCandidateCertification,
  verifyPublishedCandidate,
} from "./release/publish-candidate.ts";

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
          : ["F5-" + fixture.version + "-x86_64.AppImage", "beta-linux.yml"];
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
});
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
    expect(state.writes.some((w) => w.includes("--draft=false"))).toBe(false);
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
    await expect(verifyCandidateCertification(candidate, directory)).rejects.toThrow("acceptance");
    await expect(publishCandidate(candidate, directory)).rejects.toThrow("acceptance");
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
  it("retains the post-upload certification gate when mutable acceptance evidence changes", async () => {
    const { candidate, directory } = await candidateFixture();
    await assembleCandidate(candidate, directory);
    state.certifyAfterUpload = true;
    await expect(publishCandidate(candidate, directory)).rejects.toThrow("acceptance");
    expect(state.exists).toBe(true);
    expect(state.draft).toBe(true);
    expect(state.writes.some((write) => write.includes("--draft=false"))).toBe(false);
  });
  it("checks certification after the final gate refreshes main's evidence snapshot", async () => {
    const { candidate, directory } = await candidateFixture();
    await assembleCandidate(candidate, directory);
    let gates = 0;
    await expect(
      publishCandidate(candidate, directory, () => {
        if (++gates === 2) state.certification = true;
      }),
    ).rejects.toThrow("acceptance");
    expect(gates).toBe(2);
    expect(state.draft).toBe(true);
    expect(state.writes.some((write) => write.includes("--draft=false"))).toBe(false);
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
