// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { CLI_TARGETS, parseRelease } from "@t3tools/shared/cliRelease";
import { parseDesktopUpdateManifest } from "./desktop-update-manifest.ts";
import {
  desktopReleaseAssets,
  parseReleaseProfile,
  type ReleaseProfile,
} from "./lib/release-profile.ts";

import { validateCandidate, type ReleaseCandidate } from "./release/release-candidate.ts";
import { validatePublicationQualification } from "./release/release-upgrade-proof.ts";
const CHECKSUMS = "SHA256SUMS";

/** Requires exactly one `<sha256>  <name>` line for every other asset. */
export function verifyChecksumFile(dir: string, names: readonly string[]): void {
  const expected = names.filter((name) => name !== CHECKSUMS);
  const seen = new Set<string>();
  const content = readFileSync(join(dir, CHECKSUMS), "utf8");
  if (!content.endsWith("\n")) throw new Error(`${CHECKSUMS} must end with a newline`);
  for (const line of content.slice(0, -1).split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (!match) throw new Error(`Malformed ${CHECKSUMS} line: ${line}`);
    const [, hash, name] = match as unknown as [string, string, string];
    if (name === CHECKSUMS) throw new Error(`${CHECKSUMS} must not list itself`);
    if (!expected.includes(name)) throw new Error(`${CHECKSUMS} lists unexpected asset: ${name}`);
    if (seen.has(name)) throw new Error(`${CHECKSUMS} lists ${name} twice`);
    seen.add(name);
    if (
      createHash("sha256")
        .update(readFileSync(join(dir, name)))
        .digest("hex") !== hash
    )
      throw new Error(`${CHECKSUMS} checksum mismatch: ${name}`);
  }
  for (const name of expected)
    if (!seen.has(name)) throw new Error(`${CHECKSUMS} is missing asset: ${name}`);
}

export function verifyReleaseAssets(
  dir: string,
  version: string,
  channel: string,
  profile: ReleaseProfile,
  candidate?: ReleaseCandidate,
): void {
  if (channel !== "latest" && channel !== "beta") throw new Error("Invalid channel");
  const desktop = desktopReleaseAssets(profile, version, channel);
  const installers = desktop.installers;
  const manifests = desktop.feeds.map((feed) => feed.manifest);
  const cli = CLI_TARGETS.map((target) => `f5-${version}-${target}.tar.gz`);
  const required = [
    ...installers,
    ...desktop.requiredBlockmaps,
    ...manifests,
    ...cli,
    "f5-cli-release.json",
    CHECKSUMS,
    ...(candidate ? ["f5-release-candidate.json", "f5-release-qualification.json"] : []),
  ];
  if (candidate) {
    const provenance = JSON.parse(readFileSync(join(dir, "f5-release-candidate.json"), "utf8"));
    validateCandidate(provenance);
    if (
      JSON.stringify(provenance) !== JSON.stringify(candidate) ||
      candidate.version !== version ||
      candidate.channel !== channel ||
      candidate.profile !== profile
    )
      throw new Error("Release provenance manifest mismatch");
    const qualification = JSON.parse(
      readFileSync(join(dir, "f5-release-qualification.json"), "utf8"),
    );
    validatePublicationQualification(qualification, candidate);
  }
  const allowed = new Set([...required, ...desktop.optionalBlockmaps]);
  const names = readdirSync(dir);
  for (const name of required) if (!names.includes(name)) throw new Error(`Missing asset: ${name}`);
  for (const name of names)
    if (!allowed.has(name) || !statSync(join(dir, name)).isFile())
      throw new Error(`Unexpected asset: ${name}`);
  const verify = (
    name: string,
    size: number,
    hash: string,
    algorithm: string,
    encoding: "base64" | "hex",
  ) => {
    if (basename(name) !== name || !names.includes(name))
      throw new Error(`Invalid asset path: ${name}`);
    const bytes = readFileSync(join(dir, name));
    if (bytes.length !== size || createHash(algorithm).update(bytes).digest(encoding) !== hash)
      throw new Error(`Asset checksum/size mismatch: ${name}`);
  };
  for (const { manifest: name, installers: expected } of desktop.feeds) {
    const manifest = parseDesktopUpdateManifest(readFileSync(join(dir, name), "utf8"), name);
    if (manifest.version !== version) throw new Error(`Version mismatch: ${name}`);
    for (const file of manifest.files) {
      if (!expected.includes(file.url)) throw new Error(`Unexpected desktop URL: ${file.url}`);
      verify(file.url, file.size, file.sha512, "sha512", "base64");
      if (file.blockMapSize !== undefined && file.blockMapSize > file.size)
        throw new Error(`Invalid blockMapSize: ${file.url}`);
    }
    if (
      manifest.files.length !== expected.length ||
      expected.some((url) => !manifest.files.some((file) => file.url === url))
    )
      throw new Error(`Incomplete manifest: ${name}`);
    if (manifest.extras.path !== undefined || manifest.extras.sha512 !== undefined) {
      const entry = manifest.files.find((file) => file.url === manifest.extras.path);
      if (!entry || entry.sha512 !== manifest.extras.sha512)
        throw new Error(`Invalid primary asset: ${name}`);
    }
  }
  const release = parseRelease(JSON.parse(readFileSync(join(dir, "f5-cli-release.json"), "utf8")));
  if (release.version !== version || release.artifacts.length !== CLI_TARGETS.length)
    throw new Error("CLI version/target mismatch");
  for (const target of CLI_TARGETS) {
    const artifact = release.artifacts.find((entry) => entry.target === target);
    const name = `f5-${version}-${target}.tar.gz`;
    if (
      !artifact ||
      artifact.url !== `https://github.com/lopes-felipe/f5/releases/download/v${version}/${name}`
    )
      throw new Error(`Invalid CLI URL: ${target}`);
    verify(name, artifact.size, artifact.sha256, "sha256", "hex");
  }
  verifyChecksumFile(dir, names);
}
export function parseReleaseAssetArgs(args: string[]): {
  dir: string;
  version: string;
  channel: string;
  profile: ReleaseProfile;
} {
  let version: string | undefined;
  let channel: string | undefined;
  let profile: string | undefined;
  let dir: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--version" && !version) version = args[++index];
    else if (arg === "--channel" && !channel) channel = args[++index];
    else if (arg === "--profile" && !profile) profile = args[++index];
    else if (arg.startsWith("--") || dir) throw new Error(`Unexpected argument: ${arg}`);
    else dir = arg;
  }
  if (
    !version ||
    !channel ||
    !profile ||
    !dir ||
    version.startsWith("--") ||
    channel.startsWith("--")
  )
    throw new Error("Usage: verify-release-assets.ts --version V --channel C --profile P DIR");
  return { dir, version, channel, profile: parseReleaseProfile(profile) };
}
if (process.argv[1]?.endsWith("verify-release-assets.ts")) {
  const { dir, version, channel, profile } = parseReleaseAssetArgs(process.argv.slice(2));
  verifyReleaseAssets(dir, version, channel, profile);
}
