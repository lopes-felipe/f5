import { parseRelease, selectArtifact } from "@t3tools/shared/cliRelease";

/**
 * The linux-arm64 backend that Linux VM profiles run, pinned into a macOS arm64 release at
 * build time. The pin is the `dist:cli:archive` manifest of the archive built by the same
 * release run; the app downloads that archive the first time a VM profile needs it.
 */
export const VM_BACKEND_MANIFEST_NAME = "linux-arm64-backend.json";

/** The only URL a release downloads its VM backend from: its own release's asset. */
export const vmBackendReleaseUrl = (version: string) =>
  `https://github.com/lopes-felipe/f5/releases/download/v${version}/f5-${version}-linux-arm64.tar.gz`;

export interface VmBackendPin {
  readonly version: string;
  readonly sha256: string;
  readonly url: string;
  readonly size: number;
}

/**
 * Validates a pin for exactly `appVersion`: a linux-arm64 artifact of that version, named
 * by that version's release asset URL. Throws with the reason otherwise.
 */
export function parseVmBackendPin(value: unknown, appVersion: string): VmBackendPin {
  const release = parseRelease(value);
  const artifact = selectArtifact(release, "linux-arm64");
  if (release.version !== appVersion)
    throw new Error(`It pins ${release.version}, not this app's ${appVersion}.`);
  if (artifact.url !== vmBackendReleaseUrl(release.version))
    throw new Error("It names an archive outside this version's release.");
  return {
    version: release.version,
    sha256: artifact.sha256,
    url: artifact.url,
    size: artifact.size,
  };
}
