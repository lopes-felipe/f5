import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { promisify } from "node:util";
import type { ChromeNativeHostRegistration } from "./chromeNativeHost";
import {
  effectiveChromeRegistrations,
  parseChromeRegistryQuery,
  parseNativeHostManifest,
} from "./chromeNativeHost";

/** Certification supplies exact browser roots and registry views in Chrome lookup order. */
export type ChromeNativeHostLocation = {
  readonly browser: string;
  readonly hostName: string;
} & (
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "registry"; readonly key: string; readonly view: "32" | "64" }
);
export interface ChromeNativeHostInspectionIo {
  /** null means positively absent; all permission and unknown errors throw. */
  readonly readManifest: (path: string) => Promise<string | null>;
  /** null means positively absent; unreadable roots must not be treated as absence. */
  readonly queryRegistry: (key: string, view: "32" | "64") => Promise<string | null>;
}
const exec = promisify(execFile);
/** Queries never interpret a generic exit code 1 as absence (it can mean access denied). */
export const nativeHostInspectionIo: ChromeNativeHostInspectionIo = {
  readManifest: async (path) => {
    let file;
    try {
      file = await open(path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1024 * 1024) throw new Error("Native-host manifest exceeds the size limit.");
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  },
  queryRegistry: async (key, view) => {
    if (process.platform !== "win32" || !/^(?:HKCU|HKLM)\\[^\r\n]+$/i.test(key))
      throw new Error("Unsupported native-host registry location.");
    try {
      return (
        await exec("reg", ["query", key, `/reg:${view}`], {
          windowsHide: true,
          timeout: 10000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      const failure = error as { code?: unknown; stderr?: unknown };
      if (
        failure.code === 1 &&
        typeof failure.stderr === "string" &&
        /ERROR: The system was unable to find the specified registry key or value\./i.test(
          failure.stderr,
        )
      )
        return null;
      throw error;
    }
  },
};
/** Read-only and fail closed. No provider is launched and no registration is written. */
export async function inspectChromeNativeHosts(
  locations: ReadonlyArray<ChromeNativeHostLocation>,
  io: ChromeNativeHostInspectionIo = nativeHostInspectionIo,
): Promise<ReadonlyArray<ChromeNativeHostRegistration>> {
  const entries = await Promise.all(
    locations.map(async (slot): Promise<ChromeNativeHostRegistration> => {
      const location = slot.kind === "file" ? slot.path : `${slot.view}:${slot.key}`;
      const base = { browser: slot.browser, hostName: slot.hostName, location };
      try {
        let registrationPath = slot.kind === "file" ? slot.path : undefined;
        let registry: string | null = null;
        if (slot.kind === "registry") {
          registry = await io.queryRegistry(slot.key, slot.view);
          if (registry === null) return { ...base, state: "absent" };
          registrationPath = parseChromeRegistryQuery(registry) ?? undefined;
          if (!registrationPath) return { ...base, state: "malformed" };
        }
        const bytes = await io.readManifest(registrationPath!);
        if (bytes !== null && Buffer.byteLength(bytes) > 1024 * 1024)
          return { ...base, state: "malformed" };
        const entry = parseNativeHostManifest(slot.browser, location, bytes);
        // A registry entry pointing to a missing manifest is malformed, not absent.
        if (slot.kind === "registry" && entry.state === "absent")
          return { ...base, state: "malformed" };
        if (entry.state === "ok" && JSON.parse(bytes!).name !== slot.hostName)
          return { ...base, state: "malformed" };
        if (slot.kind === "registry" && entry.state === "ok") {
          const original = JSON.stringify({
            registry,
            manifestPath: registrationPath,
            manifestBytes: bytes,
          });
          return {
            ...entry,
            ...base,
            bytes: original,
            sha256: createHash("sha256").update(original).digest("hex"),
          };
        }
        return { ...entry, ...base };
      } catch {
        return { ...base, state: "unreadable" };
      }
    }),
  );
  return effectiveChromeRegistrations(entries);
}
