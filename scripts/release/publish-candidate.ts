// @effect-diagnostics nodeBuiltinImport:off
import { renameSync, mkdirSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  api,
  downloadArtifact,
  gh,
  git,
  hashFile,
  optionalApi,
  pages,
  repository,
  requireCi,
  show,
} from "./release-github.ts";
import { validateCandidate, type ReleaseCandidate } from "./release-candidate.ts";
import {
  assertPublishableVersion,
  missingUploads,
  type UploadedAsset,
} from "./release-publication.ts";
import { verifyReleaseAssets } from "../verify-release-assets.ts";
import {
  desktopReleaseAssets,
  fetchReleaseSummaries,
  assertReleaseProfileAllowed,
} from "../lib/release-profile.ts";
import { CLI_TARGETS } from "@t3tools/shared/cliRelease";
import { promotionProblems, remoteTagCommit } from "../lib/release-promotion.ts";
import { parseDesktopUpdateManifest } from "../desktop-update-manifest.ts";

interface RemoteRelease {
  id: number;
  draft: boolean;
  prerelease: boolean;
  tag_name: string;
  assets: UploadedAsset[];
}
/** No code from the candidate archive is executed in this privileged process. */
export async function assembleCandidate(
  candidate: ReleaseCandidate,
  directory: string,
): Promise<void> {
  validateCandidate(candidate);
  mkdirSync(directory, { recursive: true });
  for (const artifact of candidate.artifacts) {
    const metadata = api<{
      id: number;
      name: string;
      digest: string;
      expired: boolean;
      workflow_run: { id: number; head_sha: string };
    }>("actions/artifacts/" + artifact.id);
    if (
      metadata.name !== artifact.name ||
      metadata.digest !== artifact.digest ||
      metadata.workflow_run?.id !== candidate.runId ||
      metadata.workflow_run.head_sha !== candidate.sourceSha
    )
      throw new Error("Artifact identity changed");
    const dir = await downloadArtifact(metadata);
    const names = readdirSync(dir);
    if (names.length !== artifact.receipt.files.length)
      throw new Error("Artifact file inventory mismatch");
    for (const expected of artifact.receipt.files) {
      if (
        !names.includes(expected.name) ||
        statSync(join(dir, expected.name)).size !== expected.size ||
        (await hashFile(join(dir, expected.name))) !== expected.sha256
      )
        throw new Error("Component file digest mismatch: " + expected.name);
      const target = join(directory, expected.name);
      if (readdirSync(directory).includes(expected.name))
        throw new Error("Duplicate component file");
      // Both are private directories under the runner temp filesystem. Moving
      // avoids retaining a second multi-gigabyte copy of the verified files.
      renameSync(join(dir, expected.name), target);
    }
  }
  if (candidate.profile === "all") {
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL("../merge-mac-update-manifests.ts", import.meta.url)),
        join(directory, candidate.channel + "-mac.yml"),
        join(directory, candidate.channel + "-mac-x64.yml"),
      ],
      { stdio: "inherit" },
    );
  }
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("../merge-cli-release-manifests.ts", import.meta.url)),
      join(directory, "f5-cli-release.json"),
      ...CLI_TARGETS.map((t) => join(directory, "f5-" + candidate.version + "-" + t + ".json")),
    ],
    { stdio: "inherit" },
  );
  // Work only in this newly created assembly directory. Inputs remain immutable.
  const { unlinkSync } = await import("node:fs");
  for (const target of CLI_TARGETS)
    unlinkSync(join(directory, "f5-" + candidate.version + "-" + target + ".json"));
  if (candidate.profile === "all") unlinkSync(join(directory, candidate.channel + "-mac-x64.yml"));
  writeFileSync(
    join(directory, "f5-release-candidate.json"),
    JSON.stringify(candidate, null, 2) + "\n",
  );
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../assemble-release-checksums.ts", import.meta.url)), directory],
    { stdio: "inherit" },
  );
  verifyReleaseAssets(
    directory,
    candidate.version,
    candidate.channel,
    candidate.profile,
    candidate,
  );
}
export async function verifyCandidateCertification(
  candidate: ReleaseCandidate,
  directory: string,
): Promise<void> {
  const files = readdirSync(directory);
  const hashes = new Map(
    await Promise.all(
      files
        .filter((n) => n.endsWith(".dmg"))
        .map(async (n) => [n, await hashFile(join(directory, n))] as const),
    ),
  );
  const problems = promotionProblems("v" + candidate.version, {
    show,
    commitOf: () => candidate.sourceSha,
    isAncestor: (commit, revision) => {
      try {
        git(["merge-base", "--is-ancestor", commit, revision]);
        return true;
      } catch {
        return false;
      }
    },
    release: () => ({ isDraft: true, assets: files }),
    assetSha256: (_tag, name) => hashes.get(name) ?? "",
  });
  if (problems.length) throw new Error("Certification blocks candidate: " + problems.join("; "));
}
export async function publishCandidate(
  candidate: ReleaseCandidate,
  directory: string,
  beforePublish: () => void = () => {},
): Promise<void> {
  validateCandidate(candidate);
  requireCi(candidate.sourceSha, candidate.profile);
  const tag = "v" + candidate.version;
  const releases = fetchReleaseSummaries(repository);
  assertReleaseProfileAllowed(candidate.profile, releases);
  const listed = pages<RemoteRelease>("releases?per_page=100").find((r) => r.tag_name === tag);
  const files = await Promise.all(
    readdirSync(directory)
      .sort()
      .map(async (name) => ({
        name,
        size: (await import("node:fs")).statSync(join(directory, name)).size,
        sha256: await hashFile(join(directory, name)),
      })),
  );
  let release = listed;
  if (release) {
    git(["fetch", "origin", "refs/tags/" + tag + ":refs/tags/" + tag]);
    const remote = remoteTagCommit(tag, {
      local: (name) => git(["rev-list", "-n", "1", name]),
      remote: (name) =>
        git(["ls-remote", "--tags", "origin", "refs/tags/" + name, "refs/tags/" + name + "^{}"]),
    });
    if (remote !== candidate.sourceSha || release.prerelease !== (candidate.kind === "beta"))
      throw new Error("Existing release/tag has a different identity");
    const missing = missingUploads(files, release.assets);
    if (!release.draft) {
      if (missing.length) throw new Error("Published immutable release is incomplete");
      return;
    }
  }
  assertPublishableVersion(
    candidate,
    releases
      .filter((r) => !r.draft && /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(r.tag_name))
      .map((r) => r.tag_name.slice(1)),
  );
  beforePublish();
  const ref = optionalApi<{ object: { sha: string } }>("git/ref/tags/" + tag);
  if (ref && ref.object.sha !== candidate.sourceSha)
    throw new Error("Tag already points at a different commit");
  if (!ref)
    gh([
      "api",
      "--method",
      "POST",
      "repos/" + repository + "/git/refs",
      "-f",
      "ref=refs/tags/" + tag,
      "-f",
      "sha=" + candidate.sourceSha,
    ]);
  // Needed by the unchanged integration certification policy.
  git(["fetch", "origin", "refs/tags/" + tag + ":refs/tags/" + tag]);
  if (!release) {
    const notes = join(directory, "..", "notes.md");
    if (candidate.kind === "stable") {
      const text = show(candidate.sourceSha, "CHANGELOG.md") ?? "";
      const section = text.split("## [" + candidate.version + "]")[1];
      if (!section) throw new Error("Stable changelog entry missing");
      writeFileSync(
        notes,
        section
          .split("\n## [")[0]!
          .replace(/^\s*-\s*\d{4}-\d{2}-\d{2}\s*/, "")
          .trim() + "\n",
      );
    } else
      writeFileSync(
        notes,
        "Automated beta from " +
          candidate.sourceSha +
          ".\n\nSource and validation: https://github.com/" +
          repository +
          "/actions/runs/" +
          candidate.runId +
          "\n",
      );
    gh([
      "release",
      "create",
      tag,
      "--repo",
      repository,
      "--verify-tag",
      "--draft",
      "--title",
      "F5 " + tag,
      "--notes-file",
      notes,
      ...(candidate.kind === "beta" ? ["--prerelease"] : []),
    ]);
    release = pages<RemoteRelease>("releases?per_page=100").find((r) => r.tag_name === tag);
    if (!release) throw new Error("Draft was not created");
  }
  for (const name of missingUploads(files, release.assets))
    gh(["release", "upload", tag, join(directory, name), "--repo", repository]);
  release = api<RemoteRelease>("releases/" + release.id);
  if (missingUploads(files, release.assets).length) throw new Error("Release upload incomplete");
  const problems = promotionProblems(tag, {
    show,
    commitOf: () => candidate.sourceSha,
    isAncestor: (commit, revision) => {
      try {
        git(["merge-base", "--is-ancestor", commit, revision]);
        return true;
      } catch {
        return false;
      }
    },
    release: () => ({ isDraft: release!.draft, assets: release!.assets.map((a) => a.name) }),
    assetSha256: (_tag, name) => {
      // All uploaded API digests were checked against these exact local bytes above.
      const file = files.find((f) => f.name === name);
      if (!file) throw new Error("Missing certification artifact");
      return file.sha256;
    },
  });
  if (problems.length) throw new Error("Certification blocks publication: " + problems.join("; "));
  // Recheck monotonicity immediately before crossing the public boundary.
  assertPublishableVersion(
    candidate,
    fetchReleaseSummaries(repository)
      .filter((r) => !r.draft && /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(r.tag_name))
      .map((r) => r.tag_name.slice(1)),
  );
  beforePublish();
  gh([
    "release",
    "edit",
    tag,
    "--repo",
    repository,
    "--draft=false",
    ...(candidate.kind === "stable" ? ["--latest"] : []),
  ]);
}
async function publicFetch(url: string, method = "GET"): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { method, signal: AbortSignal.timeout(30_000) });
      if (response.ok) return response;
      if (attempt || ![404, 429, 502, 503, 504].includes(response.status))
        throw new Error("Public release URL unavailable (" + response.status + "): " + url);
      await response.body?.cancel();
    } catch (error) {
      if (attempt) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
/** Terminal retries verify public provenance even after Actions artifacts expire. */
export async function verifyPublishedCandidate(
  tag: string,
  sourceSha: string,
  runId: number,
): Promise<ReleaseCandidate> {
  const release = api<RemoteRelease>("releases/tags/" + tag);
  if (release.draft || release.tag_name !== tag || git(["rev-list", "-n", "1", tag]) !== sourceSha)
    throw new Error("Published release/tag identity mismatch");
  const base = "https://github.com/" + repository + "/releases/download/" + tag + "/";
  const provenance = await (await publicFetch(base + "f5-release-candidate.json")).text();
  const asset = release.assets.find((a) => a.name === "f5-release-candidate.json");
  if (asset?.digest !== "sha256:" + createHash("sha256").update(provenance).digest("hex"))
    throw new Error("Public provenance digest mismatch");
  const candidate = JSON.parse(provenance) as ReleaseCandidate;
  validateCandidate(candidate);
  if (
    candidate.sourceSha !== sourceSha ||
    candidate.runId !== runId ||
    "v" + candidate.version !== tag ||
    release.prerelease !== (candidate.kind === "beta")
  )
    throw new Error("Published candidate source/run mismatch");
  const checksums = await (await publicFetch(base + "SHA256SUMS")).text();
  if (
    release.assets.find((a) => a.name === "SHA256SUMS")?.digest !==
    "sha256:" + createHash("sha256").update(checksums).digest("hex")
  )
    throw new Error("Public checksum index digest mismatch");
  const expected = checksums
    .trimEnd()
    .split("\n")
    .map((line) => {
      const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
      if (!match) throw new Error("Invalid public checksum index");
      const uploaded = release.assets.find((a) => a.name === match[2]);
      if (!uploaded || uploaded.digest !== "sha256:" + match[1] || uploaded.state !== "uploaded")
        throw new Error("Published asset does not match checksum index");
      return match[2]!;
    });
  if (
    new Set(expected).size !== expected.length ||
    expected.length !== release.assets.length - 1 ||
    expected.includes("SHA256SUMS")
  )
    throw new Error("Incomplete public checksum inventory");
  const desktop = desktopReleaseAssets(candidate.profile, candidate.version, candidate.channel);
  const required = [
    ...desktop.installers,
    ...desktop.requiredBlockmaps,
    ...desktop.feeds.map((f) => f.manifest),
    ...CLI_TARGETS.map((t) => "f5-" + candidate.version + "-" + t + ".tar.gz"),
    "f5-cli-release.json",
    "f5-release-candidate.json",
    "SHA256SUMS",
  ];
  const names = release.assets.map((a) => a.name);
  if (
    required.some((n) => !names.includes(n)) ||
    names.some((n) => !required.includes(n) && !desktop.optionalBlockmaps.includes(n))
  )
    throw new Error("Published release asset set mismatch");
  for (const component of candidate.artifacts)
    for (const file of component.receipt.files) {
      if (
        file.name === candidate.channel + "-mac.yml" ||
        file.name === candidate.channel + "-mac-x64.yml" ||
        file.name.endsWith(".json")
      )
        continue;
      const uploaded = release.assets.find((a) => a.name === file.name);
      if (!uploaded || uploaded.size !== file.size || uploaded.digest !== "sha256:" + file.sha256)
        throw new Error("Published shipping file differs from original component");
    }
  await verifyPublicRelease(candidate);
  return candidate;
}
export async function verifyPublicRelease(candidate: ReleaseCandidate): Promise<void> {
  const base =
    "https://github.com/" + repository + "/releases/download/v" + candidate.version + "/";
  const desktop = desktopReleaseAssets(candidate.profile, candidate.version, candidate.channel);
  const feeds = [...desktop.feeds.map((f) => f.manifest), "f5-cli-release.json"];
  const installers = [
    ...desktop.installers,
    ...CLI_TARGETS.map((t) => "f5-" + candidate.version + "-" + t + ".tar.gz"),
  ];
  for (const name of installers) await publicFetch(base + name, "HEAD");
  const bases = [
    base,
    ...(candidate.kind === "stable"
      ? ["https://github.com/" + repository + "/releases/latest/download/"]
      : []),
  ];
  for (const prefix of bases)
    for (const name of feeds) {
      const response = await publicFetch(prefix + name);
      const version = name.endsWith(".json")
        ? ((await response.json()) as { version: string }).version
        : parseDesktopUpdateManifest(await response.text(), name).version;
      if (version !== candidate.version)
        throw new Error("Public update manifest version mismatch: " + name);
    }
  const provenance = (await (
    await publicFetch(base + "f5-release-candidate.json")
  ).json()) as ReleaseCandidate;
  validateCandidate(provenance);
  if (JSON.stringify(provenance) !== JSON.stringify(candidate))
    throw new Error("Public candidate provenance mismatch");
  const atom = await (
    await publicFetch("https://github.com/" + repository + "/releases.atom")
  ).text();
  if (!atom.includes("/releases/tag/v" + candidate.version + '"'))
    throw new Error("Published release missing from public Atom feed");
  if (
    candidate.kind === "stable" &&
    api<{ tag_name: string }>("releases/latest").tag_name !== "v" + candidate.version
  )
    throw new Error("Stable release was not marked Latest");
}
