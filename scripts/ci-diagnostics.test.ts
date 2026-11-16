import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
const { sanitize, writeDiagnostics } = createRequire(import.meta.url)("./lib/ci-diagnostics.cjs");

it("exports only sanitized diagnostics with no profile data", () => {
  const directory = mkdtempSync(join(tmpdir(), "f5-diagnostics-"));
  try {
    const logs =
      'Authorization: Bearer abc123\n{"token":"secret-value"}\nhttps://local/?token=query-secret&ok=1 /private/profile';
    const result = sanitize(logs, { paths: ["/private/profile"] });
    for (const secret of ["abc123", "secret-value", "query-secret", "/private/profile"])
      expect(result).not.toContain(secret);
    writeDiagnostics(directory, "test", {
      logs,
      failure: "cookie=private-cookie",
      paths: ["/private/profile"],
    });
    expect(readdirSync(join(directory, "test")).sort()).toEqual(["process.log", "result.json"]);
    expect(readFileSync(join(directory, "test", "result.json"), "utf8")).not.toContain(
      "private-cookie",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
