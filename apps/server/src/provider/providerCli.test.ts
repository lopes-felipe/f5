import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import { buildCodexCliEnvOverrides } from "./providerCli.ts";

describe("buildCodexCliEnvOverrides", () => {
  it("expands CODEX_HOME paths under the user home directory", () => {
    assert.deepEqual(buildCodexCliEnvOverrides({ homePath: "~/codex-home" }), {
      CODEX_HOME: path.join(os.homedir(), "codex-home"),
    });
  });

  it("omits empty CODEX_HOME overrides", () => {
    assert.equal(buildCodexCliEnvOverrides({ homePath: "   " }), undefined);
  });
});
