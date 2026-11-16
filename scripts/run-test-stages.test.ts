import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("runs later stages after an earlier failure and summarizes every exit code", () => {
  const cwd = mkdtempSync(join(tmpdir(), "f5-test-stages-"));
  try {
    writeFileSync(join(cwd, "fail.cjs"), "process.exitCode = 7;");
    writeFileSync(join(cwd, "pass.cjs"), "console.log('later stage ran');");
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        scripts: {
          first: "node fail.cjs",
          second: "node pass.cjs",
          third: "node pass.cjs",
        },
      }),
    );
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./run-test-stages.ts", import.meta.url)), "first", "second", "third"],
      { cwd, encoding: "utf8", timeout: 30_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout.match(/later stage ran/g)).toHaveLength(2);
    expect(result.stdout).toContain("first: exit 7");
    expect(result.stdout).toContain("second: exit 0");
    expect(result.stdout).toContain("third: exit 0");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
