import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const server = fileURLToPath(new URL("../apps/server/", import.meta.url));
it.each([
  { required: "1", archive: "", manifest: "", status: 1, skipped: 0 },
  { required: "1", archive: "missing-archive", manifest: "", status: 1, skipped: 0 },
  {
    required: "1",
    archive: "missing-archive",
    manifest: "missing-manifest",
    status: 1,
    skipped: 0,
  },
  { required: "0", archive: "", manifest: "", status: 0, skipped: 1 },
])(
  "enforces archive inputs (required=$required, archive=$archive, manifest=$manifest)",
  (input) => {
    const directory = mkdtempSync(join(tmpdir(), "f5-archive-input-test-"));
    const report = join(directory, "results.json");
    try {
      const result = spawnSync(
        process.execPath,
        [
          join(server, "node_modules/vitest/vitest.mjs"),
          "run",
          "integration/standaloneArchive.integration.test.ts",
          "--reporter=json",
          `--outputFile=${report}`,
        ],
        {
          cwd: server,
          encoding: "utf8",
          timeout: 25_000,
          env: {
            ...process.env,
            F5_REQUIRE_ARCHIVE_INTEGRATION: input.required,
            F5_CLI_SMOKE_ARCHIVE: input.archive,
            F5_CLI_SMOKE_MANIFEST: input.manifest,
            F5_CI_REPORT_DIR: "",
            F5_CI_ARTIFACT_DIR: "",
            F5_CI_SUITE_ID: "",
            VITEST_MAX_WORKERS: "1",
          },
        },
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(input.status);
      const json = JSON.parse(readFileSync(report, "utf8"));
      expect(json.numTotalTests).toBe(1);
      expect(json.numPendingTests).toBe(input.skipped);
      expect(json.numFailedTests).toBe(input.status);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
