import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  ServerConfig,
  ServerProvider,
  ServerProviderVersionAdvisory,
  ServerUpsertKeybindingResult,
  type ServerProviderVersionAdvisoryStatus,
} from "./server";
import { WS_CHANNELS, WsPush } from "./ws";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeUpsertKeybindingResult = Schema.decodeUnknownSync(ServerUpsertKeybindingResult);
const decodeServerConfig = Schema.decodeUnknownSync(ServerConfig);
const decodeConfigUpdatedPush = Schema.decodeUnknownSync(WsPush);
const decodeAvailableEditors = Schema.decodeUnknownSync(ServerConfig.fields.availableEditors);
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

describe("server config forward compatibility", () => {
  const shortcut = {
    key: "p",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
  };

  it("drops config issues with kinds this build does not know", () => {
    const parsed = decodeUpsertKeybindingResult({
      keybindings: [],
      issues: [
        { kind: "keybindings.invalid-entry", message: "Bad entry", index: 2 },
        { kind: "keybindings.future-issue", message: "From a newer server" },
      ],
    });

    expect(parsed.issues).toEqual([
      { kind: "keybindings.invalid-entry", message: "Bad entry", index: 2 },
    ]);
  });

  it("drops editor ids this build does not know", () => {
    const parsed = decodeAvailableEditors(["zed", "some-future-editor", "vscode"]);

    expect(parsed).toEqual(["zed", "vscode"]);
  });

  it("decodes a server config that contains unknown keybindings, issues and editors", () => {
    const parsed = decodeServerConfig({
      cwd: "/repo",
      keybindingsConfigPath: "/repo/.f5/keybindings.json",
      keybindings: [
        { command: "someFuture.toggle", shortcut },
        { command: "terminal.toggle", shortcut },
      ],
      customKeybindings: [
        { key: "mod+p", command: "someFuture.toggle" },
        { key: "mod+j", command: "terminal.toggle" },
      ],
      issues: [{ kind: "keybindings.future-issue", message: "From a newer server" }],
      providers: [],
      availableEditors: ["some-future-editor", "zed"],
    });

    expect(parsed.keybindings).toEqual([{ command: "terminal.toggle", shortcut }]);
    expect(parsed.customKeybindings).toEqual([{ key: "mod+j", command: "terminal.toggle" }]);
    expect(parsed.issues).toEqual([]);
    expect(parsed.availableEditors).toEqual(["zed"]);
  });

  it("drops customized rules with commands this build does not know from mutation results", () => {
    const parsed = decodeUpsertKeybindingResult({
      keybindings: [{ command: "terminal.toggle", shortcut }],
      customKeybindings: [
        { key: "mod+p", command: "someFuture.toggle" },
        { key: "mod+j", command: "terminal.toggle" },
      ],
      issues: [],
    });

    expect(parsed.customKeybindings).toEqual([{ key: "mod+j", command: "terminal.toggle" }]);
  });

  it("delivers a server.configUpdated push that contains an unknown issue kind", () => {
    const parsed = decodeConfigUpdatedPush({
      type: "push",
      sequence: 1,
      channel: WS_CHANNELS.serverConfigUpdated,
      data: {
        issues: [
          { kind: "keybindings.future-issue", message: "From a newer server" },
          { kind: "keybindings.malformed-config", message: "Bad file" },
        ],
        providers: [],
      },
    });

    expect(parsed.channel).toBe(WS_CHANNELS.serverConfigUpdated);
    expect(parsed.data).toEqual({
      issues: [{ kind: "keybindings.malformed-config", message: "Bad file" }],
      providers: [],
    });
  });
});
