import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";

export interface CodeSignatureRequirement {
  readonly teamId: string;
  readonly identifier?: string;
}
export type CodeSignatureResult =
  | { readonly ok: true; readonly teamId: string; readonly identifier: string }
  | { readonly ok: false; readonly reason: "unsupported-platform" | "invalid" | "mismatch" };

export type CodeSignatureExec = (
  file: string,
  args: ReadonlyArray<string>,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

const execCodesign: CodeSignatureExec = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(
      file,
      [...args],
      // `--deep` over a large app bundle can take well over 10 s on a cold disk.
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })),
    ),
  );

const TEAM = /^[A-Z0-9]{10}$/;
const IDENTIFIER = /^[A-Za-z0-9._-]{1,255}$/;

/** Designated requirement text; inputs are validated so they can't alter the expression. */
export function codeSignatureRequirement(requirement: CodeSignatureRequirement): string {
  if (!TEAM.test(requirement.teamId)) throw new Error("Invalid code-signing team identifier.");
  if (requirement.identifier !== undefined && !IDENTIFIER.test(requirement.identifier))
    throw new Error("Invalid code-signing identifier.");
  return `=anchor apple generic and certificate leaf[subject.OU] = "${requirement.teamId}"${
    requirement.identifier ? ` and identifier "${requirement.identifier}"` : ""
  }`;
}

/**
 * Strict, deep verification followed by `codesign -dv`. With a requirement the signature
 * must also be Apple-anchored and pinned to the team (and identifier).
 */
export async function readCodeSignature(
  path: string,
  requirement?: CodeSignatureRequirement,
  options: { platform?: string; exec?: CodeSignatureExec } = {},
): Promise<CodeSignatureResult> {
  if ((options.platform ?? process.platform) !== "darwin")
    return { ok: false, reason: "unsupported-platform" };
  const exec = options.exec ?? execCodesign;
  const expression = requirement ? codeSignatureRequirement(requirement) : undefined;
  try {
    await exec("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--deep",
      ...(expression ? ["-R", expression] : []),
      path,
    ]);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  let details: string;
  try {
    const result = await exec("/usr/bin/codesign", ["-dv", "--verbose=2", path]);
    details = `${result.stderr}\n${result.stdout}`;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const teamId = /^TeamIdentifier=([^\r\n]+)$/m.exec(details)?.[1];
  const identifier = /^Identifier=([^\r\n]+)$/m.exec(details)?.[1];
  if (!teamId || teamId === "not set" || !identifier) return { ok: false, reason: "mismatch" };
  if (
    requirement &&
    (teamId !== requirement.teamId ||
      (requirement.identifier !== undefined && identifier !== requirement.identifier))
  )
    return { ok: false, reason: "mismatch" };
  return { ok: true, teamId, identifier };
}

export function verifyCodeSignature(
  path: string,
  requirement: CodeSignatureRequirement,
  options: { platform?: string; exec?: CodeSignatureExec } = {},
): Promise<CodeSignatureResult> {
  return readCodeSignature(path, requirement, options);
}

/** Metadata fingerprint of a bundle or executable and its code-signature seal. */
export async function codeSignatureFingerprint(path: string): Promise<string> {
  const resolved = await realpath(path);
  const parts = [resolved];
  for (const target of [resolved, join(resolved, "Contents", "_CodeSignature", "CodeResources")]) {
    const info = await stat(target).catch(() => undefined);
    parts.push(info ? `${info.ino}:${info.size}:${info.mtimeMs}` : "absent");
  }
  return parts.join("\0");
}

const CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * Reuses a result for 10 minutes while the bundle's identity (realpath, inode, size,
 * mtime) and its signature seal are unchanged; a replaced or updated bundle is always
 * verified again.
 */
export class CodeSignatureCache {
  private readonly entries = new Map<
    string,
    { fingerprint: string; at: number; result: CodeSignatureResult }
  >();
  constructor(
    private readonly verify: typeof verifyCodeSignature = verifyCodeSignature,
    private readonly now: () => number = Date.now,
    private readonly fingerprint: (path: string) => Promise<string> = codeSignatureFingerprint,
  ) {}
  async probe(path: string, requirement: CodeSignatureRequirement): Promise<CodeSignatureResult> {
    const fingerprint = await this.fingerprint(path).catch(() => undefined);
    if (!fingerprint) return { ok: false, reason: "invalid" };
    const key = `${fingerprint}\0${requirement.teamId}\0${requirement.identifier ?? ""}`;
    const cached = this.entries.get(key);
    if (cached && this.now() - cached.at < CACHE_TTL_MS) return cached.result;
    const result = await this.verify(path, requirement);
    this.entries.set(key, { fingerprint, at: this.now(), result });
    return result;
  }
}
