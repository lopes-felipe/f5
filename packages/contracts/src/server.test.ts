import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  ServerProvider,
  ServerProviderVersionAdvisory,
  type ServerProviderVersionAdvisoryStatus,
} from "./server";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeVersionAdvisory = Schema.decodeUnknownSync(ServerProviderVersionAdvisory);

const baseProvider = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-05-26T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
} as const;

describe("ServerProvider.versionAdvisory", () => {
  it("decodes providers with and without optional version advisory metadata", () => {
    expect(decodeServerProvider(baseProvider).versionAdvisory).toBeUndefined();

    const decoded = decodeServerProvider({
      ...baseProvider,
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        updateCommand: {
          executable: "npm",
          args: ["install", "-g", "@openai/codex@latest"],
          channel: "npm",
        },
        checkedAt: "2026-05-26T00:00:01.000Z",
        message: "Installed v1.0.0 · latest v1.1.0",
      },
    });

    expect(decoded.versionAdvisory?.status).toBe("behind_latest");
    expect(decoded.versionAdvisory?.updateCommand?.args).toEqual([
      "install",
      "-g",
      "@openai/codex@latest",
    ]);
  });
});

describe("ServerProviderVersionAdvisory", () => {
  it.each([
    "unknown",
    "current",
    "behind_latest",
  ] satisfies ReadonlyArray<ServerProviderVersionAdvisoryStatus>)(
    "decodes %s advisories with nullable fields",
    (status) => {
      const decoded = decodeVersionAdvisory({
        status,
        currentVersion: null,
        latestVersion: null,
        updateCommand: null,
        checkedAt: null,
        message: null,
      });

      expect(decoded.status).toBe(status);
      expect(decoded.updateCommand).toBeNull();
    },
  );
});
