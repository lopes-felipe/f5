// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdtempSync,
  readFileSync,
  readdirSync,
  lstatSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parse } from "yaml";
import { artifactEntries } from "./release-publication.ts";
import { parseStableIntent, SHA_PATTERN, type StableRequest } from "./release-candidate.ts";
import {
  assertReleaseCiJobs,
  requiredReleaseCiJobs,
  selectReleaseCiRun,
  type CiRun,
  type CiJob,
  type CiWorkflow,
} from "../lib/release-qualification.ts";

export const repository = process.env.GITHUB_REPOSITORY ?? "lopes-felipe/f5";
if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
export function gh(args: readonly string[]): string {
  return execFileSync("gh", [...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
export function api<T>(path: string): T {
  return JSON.parse(gh(["api", "repos/" + repository + "/" + path])) as T;
}
export function optionalApi<T>(path: string): T | undefined {
  try {
    return api<T>(path);
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (/\(HTTP 404\)/.test(stderr)) return undefined;
    throw error;
  }
}
export function pages<T>(path: string): T[] {
  return (
    JSON.parse(gh(["api", "--paginate", "--slurp", "repos/" + repository + "/" + path])) as T[][]
  ).flat();
}
export function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}
export function show(sha: string, path: string): string | undefined {
  try {
    return git(["show", sha + ":" + path]);
  } catch {
    return undefined;
  }
}
export function stableRequests(sha: string): StableRequest[] {
  if (!SHA_PATTERN.test(sha)) throw new Error("Invalid stable request history SHA");
  const commits = git([
    "log",
    "--first-parent",
    "--reverse",
    "--format=%H",
    sha,
    "--",
    "release-intent.json",
  ])
    .split("\n")
    .filter(Boolean);
  return commits.map((sourceSha) => {
    const text = show(sourceSha, "release-intent.json");
    if (!text) throw new Error("Stable release intent must not be removed");
    return { ...parseStableIntent(JSON.parse(text)), sourceSha };
  });
}
export interface RemoteArtifact {
  id: number;
  name: string;
  digest: string;
  expired: boolean;
}
export interface WorkflowRun extends CiRun {
  workflow_id: number;
  path: string;
  repository: { full_name: string };
  head_repository: { full_name: string };
  created_at: string;
  updated_at: string;
  run_started_at: string;
}
export function runs(workflow: string, since?: string): WorkflowRun[] {
  const response = JSON.parse(
    gh([
      "api",
      "--paginate",
      "--slurp",
      "repos/" +
        repository +
        "/actions/workflows/" +
        workflow +
        "/runs?branch=main&event=push&per_page=100" +
        (since ? "&created=%3E%3D" + encodeURIComponent(since) : ""),
    ]),
  ) as { workflow_runs: WorkflowRun[] }[];
  return response.flatMap((p) => p.workflow_runs);
}
export function trustedRun(run: WorkflowRun, workflow: string): boolean {
  return (
    run.event === "push" &&
    run.head_branch === "main" &&
    run.repository.full_name === repository &&
    run.head_repository.full_name === repository &&
    run.path === ".github/workflows/" + workflow &&
    SHA_PATTERN.test(run.head_sha)
  );
}
export function requireCi(sha: string, profile: "all" | "windows"): CiRun {
  const response = api<{ workflow_runs: WorkflowRun[] }>(
    "actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=" + sha + "&per_page=100",
  );
  const run = selectReleaseCiRun(
    response.workflow_runs.filter((r) => trustedRun(r, "ci.yml")),
    sha,
  );
  const jobPages = JSON.parse(
    gh([
      "api",
      "--paginate",
      "--slurp",
      "repos/" + repository + "/actions/runs/" + run.id + "/jobs?filter=all&per_page=100",
    ]),
  ) as { jobs: CiJob[] }[];
  const workflowText = show(sha, ".github/workflows/ci.yml");
  if (!workflowText) throw new Error("Missing CI workflow at candidate SHA");
  assertReleaseCiJobs(
    jobPages.flatMap((p) => p.jobs),
    requiredReleaseCiJobs(parse(workflowText) as CiWorkflow, profile),
  );
  return run;
}
export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
/** API-provided redirect is fetched without credentials. ZIP entries must be unique flat files. */
export async function downloadArtifact(artifact: RemoteArtifact): Promise<string> {
  if (
    artifact.expired ||
    !Number.isSafeInteger(artifact.id) ||
    artifact.id < 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
  )
    throw new Error("Artifact expired or missing digest: " + artifact.name);
  const root = mkdtempSync(join(tmpdir(), "f5-release-artifact-"));
  const response = await fetch(
    "https://api.github.com/repos/" + repository + "/actions/artifacts/" + artifact.id + "/zip",
    {
      headers: {
        Authorization: "Bearer " + (process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? ""),
        Accept: "application/vnd.github+json",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.status !== 302)
    throw new Error("Could not obtain artifact download: " + response.status);
  const url = new URL(response.headers.get("location") ?? "");
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Invalid artifact redirect");
  const archive = join(root, "artifact.zip");
  const download = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!download.ok || !download.body) throw new Error("Artifact download failed");
  await pipeline(Readable.fromWeb(download.body), createWriteStream(archive, { flags: "wx" }));
  if ("sha256:" + (await hashFile(archive)) !== artifact.digest)
    throw new Error("Artifact ZIP digest mismatch");
  const names = execFileSync("unzip", ["-Z1", archive], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  })
    .trim()
    .split("\n");
  artifactEntries(names);
  const destination = join(root, "files");
  execFileSync("unzip", ["-q", "-n", archive, "-d", destination]);
  if (readdirSync(destination).some((name) => !lstatSync(join(destination, name)).isFile()))
    throw new Error("Artifact contains a non-regular file");
  unlinkSync(archive);
  return destination;
}
export async function readArtifactJson<T>(artifact: RemoteArtifact, name: string): Promise<T> {
  const dir = await downloadArtifact(artifact);
  if (readdirSync(dir).length !== 1) throw new Error("Unexpected metadata artifact contents");
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as T;
}
