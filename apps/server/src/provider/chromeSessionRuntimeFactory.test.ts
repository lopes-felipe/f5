import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import {
  PROVIDER_INTEGRATION_RECORDS,
  type ClaudeChromeRecord,
} from "@t3tools/shared/providerIntegrationCertification";
import type { ComputerAutomationBrokerRuntime } from "../computer/ComputerAutomationBroker";
import { parseNativeHostManifest } from "./chromeNativeHost";
import { ChromeNativeHostTransactions } from "./chromeNativeHostJournal";
import { makeChromeNativeHostStorage, readChromeArtifact } from "./chromeNativeHostStorage";
import {
  claudeChromeAvailability,
  listChromeSessionSetups,
  restoreChromeSessionSetup,
} from "./chromeSessionRuntimeFactory";

const base = PROVIDER_INTEGRATION_RECORDS["claude-chrome"][0]!;
const certified: ClaudeChromeRecord = {
  ...base,
  evidenceId: "fixture-evidence",
  toolNames: ["read_page"],
  evidenceCommit: "a".repeat(40),
};

let root: string;
let bundled: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "f5-chrome-identity-")));
  await mkdir(join(root, "pkg"));
  bundled = join(root, "pkg", "claude");
  await writeFile(bundled, "binary");
  await writeFile(
    join(root, "pkg", "package.json"),
    JSON.stringify({ name: base.identity.platformPackage, version: base.versions.sdkVersion }),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const check = (patch: Partial<Parameters<typeof claudeChromeAvailability>[0]> = {}) =>
  claudeChromeAvailability({
    platform: "darwin",
    arch: "arm64",
    executablePath: undefined,
    resolveDefaultExecutable: () => bundled,
    userHome: "/Users/me",
    systemHome: "/Users/me",
    records: [certified],
    ...patch,
  });

describe("Claude in Chrome executable identity", () => {
  it("stays off while no record carries evidence", async () => {
    // Built locally, so stamping the shipped record never breaks this test.
    const { evidenceId: _evidence, evidenceCommit: _commit, ...uncertified } = certified;
    expect(await check({ records: [uncertified] })).toMatchObject({
      unavailable: { reason: "not-certified" },
    });
    expect(await check({ platform: "linux" })).toMatchObject({
      unavailable: { reason: "platform" },
    });
    expect(await check({ arch: "x64" })).toMatchObject({
      unavailable: { reason: "not-certified" },
    });
  });

  it("accepts F5's bundled Claude, including through a symlink, without hashing it", async () => {
    await symlink(bundled, join(root, "link"));
    const result = await check({ executablePath: join(root, "link") });
    expect(result).toMatchObject({ record: { id: certified.id }, executableRealpath: bundled });
    expect("fingerprint" in result && result.fingerprint.startsWith(bundled)).toBe(true);
  });

  it.each([
    ["a custom binary", async () => ({ executablePath: await copy("other") }), "custom-binary"],
    ["a different home", async () => ({ userHome: "/Users/isolated" }), "home-mismatch"],
    ["an isolated F5 profile", async () => ({ isolatedProfile: true }), "isolated-profile"],
    [
      "a missing executable",
      async () => ({ executablePath: join(root, "missing") }),
      "unverifiable",
    ],
    [
      "a drifted SDK package",
      async () => {
        await writeFile(
          join(root, "pkg", "package.json"),
          JSON.stringify({ name: base.identity.platformPackage, version: "0.0.1" }),
        );
        return {};
      },
      "executable-drift",
    ],
  ])("refuses %s", async (_name, patch, reason) => {
    expect(await check(await patch())).toMatchObject({ unavailable: { reason } });
  });
});

async function copy(name: string) {
  const path = join(root, name);
  await writeFile(path, "binary");
  return path;
}

describe("storage-only restore", () => {
  it("restores while the desktop reports every record uncertified, and reports a real refusal", async () => {
    // The broker mock below refuses launch ownership, as an uncertified desktop does.
    const browser = base.browsers.find((entry) => entry.id === "chrome")!;
    const providerHome = join(root, "claude");
    const manifestPath = join(
      root,
      ...browser.nativeMessagingPath,
      `${base.identity.hostName}.json`,
    );
    const wrapperPath = join(providerHome, ...base.identity.wrapperPath);
    await mkdir(dirname(manifestPath), { recursive: true });
    await mkdir(dirname(wrapperPath), { recursive: true });
    const stateDir = join(root, "state");
    const inspect = async () => [
      parseNativeHostManifest(
        "chrome",
        manifestPath,
        (await readChromeArtifact(manifestPath)).bytes,
      ),
    ];
    const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);
    const storage = await run(
      makeChromeNativeHostStorage({ stateDir, inspect }).pipe(Effect.provide(NodeServices.layer)),
    );
    const transactions = new ChromeNativeHostTransactions(storage);
    const approved = await transactions.approve({
      provider: "claude",
      profileId: "p",
      providerInstanceId: "claudeAgent",
      recordId: base.id,
      providerHome,
      userHome: root,
      targetPath: wrapperPath,
      wrapperLocation: wrapperPath,
      observed: await inspect(),
      acceptedForeign: [],
    });
    const manifest = JSON.stringify({
      name: base.identity.hostName,
      type: "stdio",
      path: wrapperPath,
      allowed_origins: base.identity.allowedOrigins,
    });
    await writeFile(manifestPath, manifest);
    await writeFile(wrapperPath, "#!/bin/sh\nexec /x --chrome-native-host\n");
    await transactions.recordLaunch(approved);

    const sent: string[] = [];
    let refusal: ComputerControlError | undefined = new ComputerControlError({
      _tag: "Execution",
      message: "Browser control from an earlier session hasn't stopped yet.",
    });
    const broker = {
      host: {
        profileId: "p",
        correlated: async (message: { type: string }) => {
          sent.push(message.type);
          // An uncertified desktop refuses launch ownership but not restore ownership.
          if (message.type === "chromeLeaseAcquire")
            throw new ComputerControlError({ _tag: "Unavailable", reason: "not-certified" });
          if (refusal) throw refusal;
          return true;
        },
        send: (message: { type: string }) => sent.push(message.type),
      },
    } as unknown as ComputerAutomationBrokerRuntime;
    const restore = () =>
      run(
        restoreChromeSessionSetup({
          stateDir,
          provider: "claude",
          transactionId: approved.id,
          stopSessions: async () => {},
          broker,
        }).pipe(Effect.provide(NodeServices.layer)),
      );

    expect(await restore()).toEqual({
      restored: [],
      skipped: [],
      failure: "Browser control from an earlier session hasn't stopped yet.",
    });
    expect(await readFile(manifestPath, "utf8")).toBe(manifest);

    refusal = undefined;
    expect(await restore()).toMatchObject({
      restored: [manifestPath, wrapperPath],
      state: "restored",
    });
    expect(sent).toEqual(["chromeRestoreAcquire", "chromeRestoreAcquire", "chromeLeaseRelease"]);
    expect(await readChromeArtifact(manifestPath)).toEqual({ bytes: null });
    const [summary] = await run(
      listChromeSessionSetups(stateDir, "claude").pipe(Effect.provide(NodeServices.layer)),
    );
    expect(summary).toMatchObject({ id: approved.id, state: "restored" });
  });
});
