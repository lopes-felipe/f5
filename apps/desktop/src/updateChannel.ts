import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { DesktopUpdateChannel } from "@t3tools/contracts";

export function defaultUpdateChannel(version: string): DesktopUpdateChannel {
  return /-beta(\.|$)/.test(version) ? "beta" : "stable";
}
export function readUpdatePreferences(path: string): DesktopUpdateChannel | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || !("channel" in value)) return null;
    return value.channel === "beta" || value.channel === "stable" ? value.channel : null;
  } catch {
    return null;
  }
}
export function writeUpdatePreferences(path: string, channel: DesktopUpdateChannel): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ channel }));
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
export function electronUpdaterChannelSettings(channel: DesktopUpdateChannel) {
  return channel === "beta"
    ? { channel: "beta", allowPrerelease: true }
    : { channel: "latest", allowPrerelease: false };
}

export function initializeUpdatePreferences(path: string, version: string): DesktopUpdateChannel {
  const existing = readUpdatePreferences(path);
  if (existing) return existing;
  const channel = defaultUpdateChannel(version);
  try {
    writeUpdatePreferences(path, channel);
  } catch (error) {
    console.warn("[desktop-updater] Could not persist initial update channel", error);
  }
  return channel;
}
