import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, it, vi } from "vitest";

describe("resolveOpenCodeBinaryPath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns absolute binary paths without PATH lookup", async () => {
    const { resolveOpenCodeBinaryPath } = await import("./opencodeRuntime.ts");

    assert.equal(resolveOpenCodeBinaryPath("/usr/local/bin/opencode"), "/usr/local/bin/opencode");
  });

  it("resolves command names through PATH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-runtime-"));
    const binaryPath = join(dir, "opencode");
    writeFileSync(binaryPath, "#!/bin/sh\n");
    chmodSync(binaryPath, 0o700);
    vi.stubEnv("PATH", dir);
    const { resolveOpenCodeBinaryPath } = await import("./opencodeRuntime.ts");

    try {
      assert.equal(resolveOpenCodeBinaryPath("opencode"), binaryPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
