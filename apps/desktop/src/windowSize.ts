import { readFileSync, writeFileSync, renameSync } from "node:fs";

export const MIN_MAIN_WINDOW_SIZE = { width: 400, height: 360 } as const;

export function readWindowSize(path: string): { width: number; height: number } | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (
      Number.isSafeInteger(value.width) &&
      value.width >= MIN_MAIN_WINDOW_SIZE.width &&
      Number.isSafeInteger(value.height) &&
      value.height >= MIN_MAIN_WINDOW_SIZE.height
    )
      return { width: value.width, height: value.height };
  } catch {
    /* Missing or corrupt preferences use the default size. */
  }
  return null;
}

export function writeWindowSize(path: string, size: { width: number; height: number }): void {
  writeFileSync(path + ".tmp", JSON.stringify(size));
  renameSync(path + ".tmp", path);
}
