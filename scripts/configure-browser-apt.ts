import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Bypass the hosted runner's Azure-first mirror list for browser dependencies.
 * Keep suites, components, architectures and signature verification unchanged.
 * https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-apt-sources.sh
 */
export function publicUbuntuSources(source: string): string {
  return source
    .split("\n")
    .map((line) =>
      line.trimStart().startsWith("#")
        ? line
        : line.replace(
            /(?<!\S)(?:mirror\+file:\/etc\/apt\/apt-mirrors\.txt|https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?)(?=\s|$)/g,
            "https://archive.ubuntu.com/ubuntu/",
          ),
    )
    .join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Run with sudo only on the ephemeral Ubuntu browser-test runner.
  const files = ["/etc/apt/sources.list", "/etc/apt/sources.list.d/ubuntu.sources"].filter(
    existsSync,
  );
  if (!files.length) throw new Error("No Ubuntu APT source files found.");
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const updated = publicUbuntuSources(source);
    if (updated === source) continue;
    writeFileSync(file, updated);
    console.log(`Using Ubuntu's public archive for browser dependencies in ${file}.`);
  }
}
