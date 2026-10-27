import type { DesktopUpdateState } from "@t3tools/contracts";

export const STARTUP_FAILURE_RESTART_ATTEMPTS = 3;
export const STARTUP_RECOVERY_ACTION_ORIGIN = "https://startup-recovery.invalid";
export const STARTUP_RECOVERY_RELEASES_URL = "https://github.com/lopes-felipe/f5/releases";

export interface BackendStartupFailure {
  readonly reason: string;
  readonly output: string;
}

export type StartupRecoveryOffer =
  | { readonly kind: "checking" }
  | { readonly kind: "update"; readonly version: string }
  | { readonly kind: "downloading"; readonly percent: number | null }
  | { readonly kind: "download"; readonly version: string | null };

export function resolveStartupRecoveryOffer(
  update: DesktopUpdateState,
  lastStartedVersion: string | null,
  failedInstallVersion: string | null,
): StartupRecoveryOffer {
  if (update.enabled && update.status === "downloading")
    return { kind: "downloading", percent: update.downloadPercent };
  const version =
    update.downloadedVersion ?? (update.status === "available" ? update.availableVersion : null);
  if (
    update.enabled &&
    version &&
    version !== failedInstallVersion &&
    version !== update.currentVersion
  )
    return { kind: "update", version };
  if (update.enabled && (update.status === "idle" || update.status === "checking"))
    return { kind: "checking" };
  return {
    kind: "download",
    version: lastStartedVersion !== update.currentVersion ? lastStartedVersion : null,
  };
}

/** Separate streaming decoders preserve Unicode split between output chunks. */
export class BackendOutputTail {
  private text = "";
  private readonly decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  append(stream: "stdout" | "stderr", bytes: Uint8Array): void {
    this.text = (this.text + this.decoders[stream].decode(bytes, { stream: true })).slice(-4_000);
    const first = this.text.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) this.text = "\uFFFD" + this.text.slice(1);
  }
  get value(): string {
    return this.text;
  }
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

export function startupRecoveryAction(
  url: string,
): "update" | "download" | "copy" | "retry" | "quit" | null {
  try {
    const target = new URL(url);
    if (target.origin !== STARTUP_RECOVERY_ACTION_ORIGIN) return null;
    const action = target.pathname.slice(1);
    return action === "update" ||
      action === "download" ||
      action === "copy" ||
      action === "retry" ||
      action === "quit"
      ? action
      : null;
  } catch {
    return null;
  }
}

export function startupRecoveryHtml(input: {
  readonly version: string;
  readonly profile: string;
  readonly failure: BackendStartupFailure;
  readonly offer: StartupRecoveryOffer;
  readonly logDir: string;
}): string {
  const { offer } = input;
  const link = (action: string, label: string) =>
    '<a href="' + STARTUP_RECOVERY_ACTION_ORIGIN + "/" + action + '">' + escapeHtml(label) + "</a>";
  const description =
    offer.kind === "checking"
      ? "Checking for a newer version…"
      : offer.kind === "downloading"
        ? "Downloading the update…"
        : offer.kind === "update"
          ? "A newer version is available."
          : offer.version
            ? "Version " +
              offer.version +
              " started successfully on this computer. Download and reinstall it to go back."
            : "Download a different version from the releases page.";
  const action =
    offer.kind === "update"
      ? link("update", "Update to " + offer.version)
      : offer.kind === "download"
        ? link("download", offer.version ? "Download " + offer.version : "Open releases")
        : "";
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>F5 could not start</title><style>' +
    "html{color-scheme:light dark}body{font:14px/1.5 system-ui;margin:28px}h1{font-size:22px}a{display:inline-block;color:inherit;border:1px solid gray;border-radius:6px;padding:8px 12px;margin:0 8px 8px 0;text-decoration:none}pre{white-space:pre-wrap;overflow:auto;max-height:45vh;border:1px solid gray;padding:12px}small{opacity:.7}" +
    "</style></head><body><h1>F5 could not start</h1><p>" +
    escapeHtml(input.profile + ": " + input.failure.reason) +
    "</p><p>" +
    escapeHtml(description) +
    "</p>" +
    action +
    link("retry", "Retry") +
    link("copy", "Copy details") +
    link("quit", "Quit") +
    "<pre>" +
    escapeHtml(input.failure.output.trim() || "The server wrote no output.") +
    "</pre><small>Version " +
    escapeHtml(input.version) +
    ". Logs: " +
    escapeHtml(input.logDir) +
    "</small></body></html>"
  );
}
