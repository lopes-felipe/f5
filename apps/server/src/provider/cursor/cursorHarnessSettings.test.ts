import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  CURSOR_HARNESS_PINNED_MIGRATION,
  pinCursorHarnessInDocument,
  pinCursorHarnessInPatch,
} from "./cursorHarnessSettings.ts";

const available = { available: true } as const;
const unavailable = { available: false, reason: "SDK not certified here." } as const;

const withInstances = (
  providerInstances: Record<string, { driver: string; config?: unknown }>,
): ServerSettings =>
  ({ ...DEFAULT_SERVER_SETTINGS, providerInstances }) as unknown as ServerSettings;

describe("pinCursorHarnessInDocument", () => {
  it("pins the legacy block and unpinned Cursor instances of an existing profile", () => {
    const pinned = pinCursorHarnessInDocument({
      providers: { cursor: { binaryPath: "agent" } },
      providerInstances: {
        work: { driver: "cursor", config: { apiEndpoint: "" } },
        sdk: { driver: "cursor", config: { harness: "sdk" } },
        codex: { driver: "codex", config: {} },
      },
    });
    expect(pinned.providers).toEqual({ cursor: { binaryPath: "agent", harness: "acp" } });
    expect(pinned.providerInstances).toEqual({
      work: { driver: "cursor", config: { apiEndpoint: "", harness: "acp" } },
      sdk: { driver: "cursor", config: { harness: "sdk" } },
      codex: { driver: "codex", config: {} },
    });
  });

  it("leaves documents that already carry the marker alone", () => {
    const document = {
      clientSettingMigrations: { [CURSOR_HARNESS_PINNED_MIGRATION]: "2026-11-23T00:00:00.000Z" },
      providerInstances: { work: { driver: "cursor", config: {} } },
    };
    expect(pinCursorHarnessInDocument(document)).toBe(document);
  });
});

describe("pinCursorHarnessInPatch", () => {
  const current = withInstances({ work: { driver: "cursor", config: { harness: "acp" } } });

  it("rejects a patch that changes an existing instance's harness", () => {
    const result = pinCursorHarnessInPatch(
      current,
      { providerInstances: { work: { driver: "cursor", config: { harness: "sdk" } } } } as never,
      available,
    );
    expect(result.ok).toBe(false);
  });

  it("keeps the current harness when a patch omits it", () => {
    const result = pinCursorHarnessInPatch(
      current,
      {
        providerInstances: { work: { driver: "cursor", config: { binaryPath: "/bin/agent" } } },
      } as never,
      available,
    );
    expect(result).toMatchObject({
      ok: true,
      patch: {
        providerInstances: {
          work: { config: { binaryPath: "/bin/agent", harness: "acp" } },
        },
      },
    });
  });

  it("refuses a new SDK instance while the host cannot run the SDK harness", () => {
    const result = pinCursorHarnessInPatch(
      current,
      { providerInstances: { fresh: { driver: "cursor", config: { harness: "sdk" } } } } as never,
      unavailable,
    );
    expect(result).toEqual({ ok: false, issue: "SDK not certified here." });
  });

  it("rejects a legacy-block harness change", () => {
    const result = pinCursorHarnessInPatch(
      current,
      { providers: { cursor: { harness: "sdk" } } } as never,
      available,
    );
    expect(result.ok).toBe(false);
  });
});
