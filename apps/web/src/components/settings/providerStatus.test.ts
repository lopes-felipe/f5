import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  formatProviderUpdateCommand,
  getProviderVersionAdvisoryPresentation,
} from "./providerStatus";

const baseProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-05-26T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const updateCommand = {
  executable: "npm",
  args: ["install", "-g", "@openai/codex@latest"],
  channel: "npm",
} as const;

describe("provider update advisory presentation", () => {
  it("shows behind-latest advisories that have a latest version and command", () => {
    const presentation = getProviderVersionAdvisoryPresentation(
      {
        ...baseProvider,
        versionAdvisory: {
          status: "behind_latest",
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          updateCommand,
          checkedAt: "2026-05-26T00:00:00.000Z",
          message: null,
        },
      },
      undefined,
    );

    expect(presentation).toEqual({
      message: "Installed v1.0.0 · latest v1.1.0",
      updateCommand,
      latestVersion: "1.1.0",
    });
  });

  it("hides current, unknown, incomplete, and dismissed advisories", () => {
    expect(
      getProviderVersionAdvisoryPresentation(
        {
          ...baseProvider,
          versionAdvisory: {
            status: "current",
            currentVersion: "1.1.0",
            latestVersion: "1.1.0",
            updateCommand: null,
            checkedAt: "2026-05-26T00:00:00.000Z",
            message: null,
          },
        },
        undefined,
      ),
    ).toBeNull();

    expect(
      getProviderVersionAdvisoryPresentation(
        {
          ...baseProvider,
          versionAdvisory: {
            status: "unknown",
            currentVersion: "1.0.0",
            latestVersion: null,
            updateCommand: null,
            checkedAt: null,
            message: null,
          },
        },
        undefined,
      ),
    ).toBeNull();

    expect(
      getProviderVersionAdvisoryPresentation(
        {
          ...baseProvider,
          versionAdvisory: {
            status: "behind_latest",
            currentVersion: "1.0.0",
            latestVersion: "1.1.0",
            updateCommand: null,
            checkedAt: null,
            message: null,
          },
        },
        undefined,
      ),
    ).toBeNull();

    expect(
      getProviderVersionAdvisoryPresentation(
        {
          ...baseProvider,
          versionAdvisory: {
            status: "behind_latest",
            currentVersion: "1.0.0",
            latestVersion: "1.1.0",
            updateCommand,
            checkedAt: null,
            message: null,
          },
        },
        "1.1.0",
      ),
    ).toBeNull();
  });

  it("formats structured update commands for copy", () => {
    expect(formatProviderUpdateCommand(updateCommand)).toBe("npm install -g @openai/codex@latest");
  });

  it("quotes unsafe argv when formatting copy text", () => {
    expect(
      formatProviderUpdateCommand({
        executable: "npm",
        args: ["install", "-g", "@scope/package with spaces@latest", "needs'quote"],
        channel: "npm",
      }),
    ).toBe("npm install -g '@scope/package with spaces@latest' 'needs'\\''quote'");
  });
});
