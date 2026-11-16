import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

// The release workflows run these under plain Node, which rejects extensionless
// relative imports that Vitest and bundlers accept. A resolution failure here
// means the publisher crashes before it can qualify any candidate.
const modules = [
  ...readdirSync(new URL("./release", import.meta.url)).map((file) => `scripts/release/${file}`),
  ...readdirSync(new URL("./lib", import.meta.url))
    .filter((file) => file.startsWith("release-"))
    .map((file) => `scripts/lib/${file}`),
].filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));

it("loads every release library module under plain Node", () => {
  expect(modules.length).toBeGreaterThan(10);
  const script = `for (const file of ${JSON.stringify(modules)}) await import("./" + file);`;
  expect(() =>
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    }),
  ).not.toThrow();
}, 60_000);
