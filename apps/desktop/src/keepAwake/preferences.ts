import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { DesktopKeepAwakeMode } from "@t3tools/contracts";

export interface Preferences {
  mode: DesktopKeepAwakeMode;
  closedLid: boolean;
}
export const defaults: Preferences = { mode: "off", closedLid: false };
export async function atomicWrite(path: string, value: unknown) {
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
}
export async function readPreferences(path: string): Promise<Preferences> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (["off", "agents", "always"].includes(value.mode) && typeof value.closedLid === "boolean")
      return { mode: value.mode, closedLid: value.closedLid };
  } catch {
    /* Missing or invalid preferences default to opt-out. */
  }
  return { ...defaults };
}
