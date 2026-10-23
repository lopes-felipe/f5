/**
 * Single-writer claim per repository: one F5 profile on one machine records
 * upstream ops and runs the schedule. The claim lives beside the cross-profile
 * repository locks so every profile sees it.
 *
 * @module upstreamPorts/writerClaim
 */
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { UpstreamWriterClaim } from "@t3tools/contracts";

import { repositoryIdentityHash } from "../project/Layers/WorktreeLifecycleCoordinator.ts";

export interface WriterIdentity {
  readonly profileId: string;
  readonly stateDir: string;
  readonly hostname: string;
}

export interface WriterClaimFile extends WriterIdentity {
  readonly claimedAt: string;
}

export function writerClaimPath(baseDir: string, canonicalCommonDir: string): string {
  return path.join(
    baseDir,
    "upstream-writers",
    `${repositoryIdentityHash(canonicalCommonDir)}.json`,
  );
}

/** The claim, or null when the file is missing or invalid. Other I/O errors reject. */
export async function readWriterClaim(file: string): Promise<WriterClaimFile | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: Partial<WriterClaimFile> | null;
  try {
    value = JSON.parse(text) as Partial<WriterClaimFile> | null;
  } catch {
    return null;
  }
  if (
    typeof value?.profileId !== "string" ||
    typeof value.stateDir !== "string" ||
    typeof value.hostname !== "string" ||
    typeof value.claimedAt !== "string"
  )
    return null;
  return value as WriterClaimFile;
}

export const isSameWriter = (claim: WriterIdentity, me: WriterIdentity) =>
  claim.stateDir === me.stateDir && claim.hostname === me.hostname;

/**
 * Writes the claim complete to a temp file first, so readers never see a
 * partial claim. An exclusive write hard-links it into place, which fails
 * when a claim exists; otherwise it replaces any claim.
 */
async function writeClaim(
  file: string,
  claim: WriterClaimFile,
  exclusive: boolean,
): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temp, `${JSON.stringify(claim, null, 2)}\n`, { mode: 0o600 });
  if (!exclusive) {
    await rename(temp, file);
    return true;
  }
  try {
    await link(temp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}

/** Claims the repository when nobody has; returns whether this profile is the writer. */
export async function ensureWriterClaim(
  file: string,
  me: WriterIdentity,
  now: string,
): Promise<boolean> {
  const existing = await readWriterClaim(file);
  if (existing) return isSameWriter(existing, me);
  const claim = { ...me, claimedAt: now };
  if (await writeClaim(file, claim, true)) return true;
  const raced = await readWriterClaim(file);
  if (raced) return isSameWriter(raced, me);
  // The file exists but is not a valid claim (corrupt or emptied): replace it,
  // then re-read in case another profile replaced it at the same time.
  await writeClaim(file, claim, false);
  const replaced = await readWriterClaim(file);
  return replaced !== null && isSameWriter(replaced, me);
}

export async function takeOverWriterClaim(
  file: string,
  me: WriterIdentity,
  now: string,
): Promise<void> {
  await writeClaim(file, { ...me, claimedAt: now }, false);
}

export async function describeWriterClaim(
  file: string,
  me: WriterIdentity,
): Promise<UpstreamWriterClaim> {
  const claim = await readWriterClaim(file);
  return {
    claimed: claim !== null,
    managedByThisProfile: claim !== null && isSameWriter(claim, me),
    profileId: claim?.profileId ?? null,
    hostname: claim?.hostname ?? null,
    claimedAt: claim?.claimedAt ?? null,
  };
}
