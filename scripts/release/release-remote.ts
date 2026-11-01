// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { gh, pages, repository } from "./release-github.ts";
import type { UploadedAsset } from "./release-publication.ts";
import { releaseFields, releaseRetry } from "./release-observability.ts";

export interface RemoteRelease {
  id: number;
  draft: boolean;
  prerelease: boolean;
  tag_name: string;
  assets: UploadedAsset[];
}
const exec = promisify(execFile);
export const releaseDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function findRelease(tag: string): RemoteRelease | undefined {
  const found = pages<RemoteRelease>("releases?per_page=100").filter((r) => r.tag_name === tag);
  if (found.length > 1) throw new Error("Duplicate release identity");
  return found[0];
}
export function validateRemoteRelease(release: RemoteRelease, tag: string, beta: boolean): void {
  if (
    !Number.isSafeInteger(release.id) ||
    release.id < 1 ||
    release.tag_name !== tag ||
    typeof release.draft !== "boolean" ||
    release.prerelease !== beta ||
    !Array.isArray(release.assets)
  )
    throw new Error("Release API returned a different identity");
}
export async function createDraft(
  tag: string,
  beta: boolean,
  notes: string,
): Promise<RemoteRelease> {
  let release: RemoteRelease;
  try {
    release = JSON.parse(
      gh([
        "api",
        "--method",
        "POST",
        "repos/" + repository + "/releases",
        "-f",
        "tag_name=" + tag,
        "-f",
        "name=F5 " + tag,
        "-f",
        "body=" + readFileSync(notes, "utf8"),
        "-F",
        "draft=true",
        "-F",
        "prerelease=" + beta,
        "-f",
        "make_latest=false",
      ]),
    ) as RemoteRelease;
  } catch (error) {
    // An ambiguous POST must never be repeated. Discover its result once.
    if (
      !/HTTP (?:429|50[0234])|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|timeout|socket|unexpected EOF/i.test(
        String((error as { stderr?: unknown }).stderr ?? "") + String(error),
      )
    )
      throw error;
    releaseRetry("draft-discovery");
    await releaseDelay(5000);
    const found = findRelease(tag);
    if (!found) throw error;
    release = found;
  }
  validateRemoteRelease(release, tag, beta);
  if (!release.draft) throw new Error("New draft became public before verification");
  releaseFields({ releaseId: release.id });
  return release;
}
/** gh streams the file from disk; no shell, argv token or candidate execution. */
export async function uploadReleaseAsset(
  id: number,
  name: string,
  path: string,
  request: (args: string[]) => Promise<void> = async (args) => {
    await exec("gh", args, { maxBuffer: 1024 * 1024 });
  },
): Promise<void> {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid release ID");
  await request([
    "api",
    "--method",
    "POST",
    "-H",
    "Content-Type: application/octet-stream",
    "https://uploads.github.com/repos/" +
      repository +
      "/releases/" +
      id +
      "/assets?name=" +
      encodeURIComponent(name),
    "--input",
    path,
  ]);
}
export function promoteRelease(id: number, beta: boolean): void {
  gh([
    "api",
    "--method",
    "PATCH",
    "repos/" + repository + "/releases/" + id,
    "-F",
    "draft=false",
    "-F",
    "prerelease=" + beta,
    "-f",
    "make_latest=" + !beta,
  ]);
}
