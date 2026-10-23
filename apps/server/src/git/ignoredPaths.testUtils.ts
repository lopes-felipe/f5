import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** More than the Git service's output limit when expanded, one entry when collapsed. */
export async function createLargeIgnoredDependencyTree(checkout: string): Promise<string> {
  const directory = path.join(checkout, "node_modules", "fixture");
  await fs.mkdir(directory, { recursive: true });
  for (let start = 0; start < 4500; start += 50)
    await Promise.all(
      Array.from({ length: 50 }, (_, offset) =>
        fs.writeFile(path.join(directory, `${"x".repeat(230)}-${start + offset}`), ""),
      ),
    );
  const expanded = execFileSync(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    { cwd: checkout, maxBuffer: 4 * 1024 * 1024 },
  );
  if (expanded.byteLength <= 1_000_000) throw new Error("Ignored-path fixture is too small");
  return directory;
}
