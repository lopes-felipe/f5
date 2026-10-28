import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as certification from "@t3tools/shared/providerIntegrationCertification";
import {
  CODEX_CHROME_NEEDS_FULL_ACCESS,
  CODEX_CHROME_NEEDS_ISOLATED_HOME,
} from "../computer/codexNativeIntegrations";
import {
  CODEX_CHROME_UNSIGNED_CODEX,
  codexChromeEligibility,
  codexChromeFingerprint,
  codexChromeMcpServer,
  effectiveCodexHome,
} from "./codexChromeIntegration";

const record = certification.PROVIDER_INTEGRATION_RECORDS["codex-chrome"][0]!;
let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
const certify = () =>
  vi.spyOn(certification, "certifiedIntegrationRecord").mockReturnValue({
    ...record,
    versions: { ...record.versions, codexMin: "0.162.1" },
    evidenceId: "fixture",
    toolInventorySha256: "a".repeat(64),
  } as never);
const codex = { path: "/opt/codex/bin/codex", version: "0.163.0" };
const signed = vi.fn(async () => true);

describe("Codex Chrome eligibility", () => {
  it("reads nothing while the record is uncertified", async () => {
    const inspect = vi.fn();
    const result = await codexChromeEligibility({
      codexHome: "/isolated",
      userHome: "/Users/me",
      platform: "darwin",
      arch: "arm64",
      runtimeMode: "full-access",
      codex,
      codexSigned: signed,
      inspect,
    });
    expect(result).toMatchObject({ eligible: false });
    if (!certification.isIntegrationCertified("codex-chrome", "darwin", "arm64"))
      expect(inspect).not.toHaveBeenCalled();
  });

  it("requires Full access and an isolated CODEX_HOME", async () => {
    certify();
    root = await mkdtemp(join(tmpdir(), "f5-codex-chrome-"));
    const inspect = vi.fn(async () => ({
      available: false as const,
      state: "version" as const,
      reason: "x",
    }));
    const base = {
      userHome: root,
      platform: "darwin",
      arch: "arm64",
      inspect,
      runtimeMode: "preflight" as const,
      codex,
      codexSigned: signed,
    };
    expect(
      await codexChromeEligibility({
        ...base,
        codexHome: "/isolated",
        runtimeMode: "auto-accept-edits",
      }),
    ).toMatchObject({
      eligible: false,
      reason: CODEX_CHROME_NEEDS_FULL_ACCESS,
    });
    expect(await codexChromeEligibility({ ...base, codexHome: undefined })).toMatchObject({
      reason: CODEX_CHROME_NEEDS_ISOLATED_HOME,
    });
    expect(
      await codexChromeEligibility({ ...base, codexHome: join(root, ".codex") }),
    ).toMatchObject({
      reason: CODEX_CHROME_NEEDS_ISOLATED_HOME,
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(
      await codexChromeEligibility({
        ...base,
        codexHome: join(root, "isolated"),
        runtimeMode: "full-access",
      }),
    ).toMatchObject({
      eligible: false,
      reason: "x",
    });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("requires an OpenAI-signed Codex at or above the record's floor", async () => {
    certify();
    root = await mkdtemp(join(tmpdir(), "f5-codex-chrome-"));
    const inspect = vi.fn(async () => ({
      available: false as const,
      state: "version" as const,
      reason: "x",
    }));
    const base = {
      userHome: root,
      codexHome: join(root, "isolated"),
      platform: "darwin",
      arch: "arm64",
      inspect,
      runtimeMode: "full-access" as const,
      codexSigned: signed,
    };
    expect(
      await codexChromeEligibility({ ...base, codex: { ...codex, version: "0.161.0" } }),
    ).toMatchObject({
      reason: "Codex Chrome control needs Codex 0.162.1 or newer; F5 runs 0.161.0.",
    });
    expect(await codexChromeEligibility({ ...base, codex: { path: codex.path } })).toMatchObject({
      reason: "Codex Chrome control needs Codex 0.162.1 or newer.",
    });
    // The settings preflight never runs Codex, so an unknown version isn't a refusal there.
    expect(
      await codexChromeEligibility({
        ...base,
        runtimeMode: "preflight",
        codex: { path: codex.path },
      }),
    ).toMatchObject({ reason: "x" });
    expect(
      await codexChromeEligibility({ ...base, codex, codexSigned: async () => false }),
    ).toMatchObject({ reason: CODEX_CHROME_UNSIGNED_CODEX });
    expect(
      await codexChromeEligibility({ ...base, codex: { version: codex.version } }),
    ).toMatchObject({ reason: CODEX_CHROME_UNSIGNED_CODEX });
    expect(signed).toHaveBeenCalledWith(codex.path, record.identity.teamId);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  // POSIX home paths; Codex Chrome is macOS only.
  it.skipIf(process.platform === "win32")("uses the CODEX_HOME Codex itself runs with", () => {
    expect(effectiveCodexHome("/configured", { CODEX_HOME: "/inherited" })).toBe("/configured");
    // An isolated profile (or the user) already points Codex at its own home.
    expect(effectiveCodexHome(undefined, { CODEX_HOME: "/inherited" })).toBe("/inherited");
    expect(effectiveCodexHome(undefined, {})).toBe(join(homedir(), ".codex"));
  });

  it("has Codex start node_repl with only the allowed tools and the drain hook", () => {
    const installation = {
      record,
      appVersion: "26.1016.62342",
      pluginRoot: "/plugin",
      serviceScript: "/plugin/browser.js",
      nodeRepl: "/plugin/bin/node_repl",
      nodePath: "/plugin/bin/node",
      nodeModules: "/plugin/node_modules",
    } as never;
    const server = codexChromeMcpServer(
      { eligible: true, installation, codexHome: "/isolated" },
      {
        PATH: "/usr/bin",
        SECRET: "x",
      },
    );
    expect(server).toMatchObject({
      type: "stdio",
      command: "/plugin/bin/node_repl",
      args: [],
      enabledTools: [...record.identity.allowedTools, certification.CODEX_CHROME_DRAIN_TOOL],
    });
    expect(server.type === "stdio" && server.env).toMatchObject({
      PATH: "/usr/bin",
      CODEX_HOME: "/isolated",
      NODE_REPL_NODE_PATH: "/plugin/bin/node",
    });
    expect(server.type === "stdio" && server.env?.SECRET).toBeUndefined();
  });

  it("restarts only when the toggle changes", () => {
    expect(codexChromeFingerprint(true)).not.toBe(codexChromeFingerprint(false));
    expect(codexChromeFingerprint(true)).toBe(codexChromeFingerprint(true));
  });
});
