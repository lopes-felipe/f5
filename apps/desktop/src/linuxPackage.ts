import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** electron-builder writes this marker only into installed Debian packages. */
export async function isDebPackage(
  platform: NodeJS.Platform,
  resourcesPath: string,
): Promise<boolean> {
  if (platform !== "linux") return false;
  try {
    return (await readFile(join(resourcesPath, "package-type"), "utf8")).trim() === "deb";
  } catch {
    return false;
  }
}
