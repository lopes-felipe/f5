import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import {
  PROVIDER_INTEGRATION_RECORDS,
  type ClaudeChromeRecord,
} from "@t3tools/shared/providerIntegrationCertification";
import { ChromeArtifactCache, defaultChromeArtifactCacheIo } from "./chromeArtifactCache";
import { claudeChromeDescriptor, parseNativeHostManifest } from "./chromeNativeHost";
import { makeChromeNativeHostStorage, readChromeArtifact } from "./chromeNativeHostStorage";
import { ChromeSessionRuntime, type ChromeRuntimeDeps } from "./chromeSessionRuntime";
import { CLAUDE_IN_CHROME_EXTERNAL_CONFLICT } from "./Layers/claudeAgentBrowser";

const base = PROVIDER_INTEGRATION_RECORDS["claude-chrome"][0]!;
const record: ClaudeChromeRecord = {
  ...base,
  browsers: base.browsers.slice(0, 1),
  toolNames: ["read_page", "navigate", "computer", "browser_batch", "file_upload"],
};
const descriptor = claudeChromeDescriptor(record);

let root: string;
let exe: string;
let providerHome: string;
let manifestPath: string;
let wrapperPath: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "f5-chrome-runtime-")));
  exe = join(root, "claude");
  providerHome = join(root, "provider");
  await writeFile(exe, "binary");
  const location = descriptor.locations(providerHome, root)[0]!;
  manifestPath = location.kind === "file" ? location.path : "";
  wrapperPath = descriptor.expectedTarget(providerHome);
  await mkdir(dirname(manifestPath), { recursive: true });
  await mkdir(dirname(wrapperPath), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const manifest = (path: string) =>
  JSON.stringify({
    name: record.identity.hostName,
    type: "stdio",
    path,
    allowed_origins: record.identity.allowedOrigins,
  });
/** What the CLI writes when it connects. */
const cliLaunch = async () => {
  await writeFile(manifestPath, manifest(wrapperPath));
  await writeFile(
    wrapperPath,
    `${record.identity.wrapperHeader.join("\n")}\nexec ${exe} --chrome-native-host\n`,
    { mode: 0o755 },
  );
};
const verifiedStatus = () => ({
  name: "claude-in-chrome",
  status: "connected",
  scope: "dynamic",
  config: { type: "stdio", command: exe, args: ["--claude-in-chrome-mcp"] },
});
const session = () => ({
  threadId: "t",
  generation: "g1",
  providerHome,
  providerInstanceId: "claudeAgent",
});
const call = (toolName: string, input: unknown = {}, extra: Record<string, unknown> = {}) => ({
  toolName: `mcp__claude-in-chrome__${toolName}`,
  input,
  generation: "g1",
  ...extra,
});

async function setup(overrides: Partial<ChromeRuntimeDeps> = {}) {
  const inspect = async () => {
    const read = await readChromeArtifact(manifestPath);
    return [parseNativeHostManifest("chrome", manifestPath, read.bytes)];
  };
  const storage = await Effect.runPromise(
    makeChromeNativeHostStorage({ stateDir: join(root, "state"), inspect }).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
  const state = { policy: true, paused: false };
  const { watch: _watch, ...io } = defaultChromeArtifactCacheIo;
  const cache = new ChromeArtifactCache(io);
  const deps: ChromeRuntimeDeps = {
    descriptor,
    record,
    storage,
    profileId: "profile",
    userHome: root,
    executableRealpath: exe,
    acquire: vi.fn(async () => {}),
    release: vi.fn(),
    validate: vi.fn(async () => {}),
    consent: vi.fn(async () => true),
    paused: () => state.paused,
    policyEnabled: async () => state.policy,
    currentGeneration: () => "g1",
    cache,
    launchTimeoutMs: 50,
    ...overrides,
  };
  return { runtime: new ChromeSessionRuntime(deps), deps, state, cache, storage: deps.storage };
}

async function connected(h: Awaited<ReturnType<typeof setup>>) {
  await h.runtime.prepare(session());
  await cliLaunch();
  expect(await h.runtime.connected("t", "g1", verifiedStatus())).toBe(true);
}

// Claude in Chrome is macOS only; the fixtures use macOS browser paths.
describe.skipIf(process.platform === "win32")("Claude in Chrome session runtime", () => {
  it("asks before replacing foreign setup and journals it before launch", async () => {
    await writeFile(manifestPath, manifest("/Applications/Other.app/host"));
    const h = await setup();
    expect(await h.runtime.prepare(session())).toEqual({ kind: "launch", targetPath: wrapperPath });
    expect(h.deps.consent).toHaveBeenCalledWith(
      session(),
      expect.objectContaining({ previousTargets: ["/Applications/Other.app/host"] }),
    );
    const [transaction] = await h.storage.listTransactions("claude");
    expect(transaction).toMatchObject({
      state: "approved",
      recordId: record.id,
      providerInstanceId: "claudeAgent",
    });
    expect(transaction?.slots.map((slot) => slot.kind)).toEqual(["manifest", "wrapper"]);
    expect(h.runtime.status("t", "g1")).toEqual({ state: "pending" });
  });

  it("releases the lease and launches nothing when consent is declined", async () => {
    await writeFile(manifestPath, manifest("/foreign"));
    const h = await setup({ consent: vi.fn(async () => false) });
    expect(await h.runtime.prepare(session())).toMatchObject({ kind: "off" });
    expect(h.deps.release).toHaveBeenCalledTimes(1);
    expect(await h.storage.listTransactions("claude")).toEqual([]);
  });

  it("cancels setup when the toggle is turned off while the dialog is open", async () => {
    await writeFile(manifestPath, manifest("/foreign"));
    let state: { policy: boolean } | undefined;
    const h = await setup({
      consent: vi.fn(async () => {
        state!.policy = false;
        return true;
      }),
    });
    state = h.state;
    await expect(h.runtime.prepare(session())).rejects.toThrow("interrupted");
    expect(h.deps.release).toHaveBeenCalledTimes(1);
    expect(await h.storage.listTransactions("claude")).toEqual([]);
  });

  it("never prompts again for this instance's own verified setup", async () => {
    const h = await setup();
    await connected(h);
    await h.runtime.finalize("t", "g1");
    const again = await setup();
    await again.runtime.prepare(session());
    expect(again.deps.consent).not.toHaveBeenCalled();
  });

  it("denies tools until the server and registration are verified", async () => {
    const h = await setup();
    await h.runtime.prepare(session());
    expect(await h.runtime.admit(call("read_page"), "t")).toContain("isn't connected yet");
    await cliLaunch();
    expect(await h.runtime.connected("t", "g1", { ...verifiedStatus(), scope: "project" })).toBe(
      false,
    );
    expect(h.runtime.status("t", "g1")?.state).toBe("failed");
    // Failed sessions return only through an explicit reconnect.
    expect(await h.runtime.connected("t", "g1", verifiedStatus())).toBe(false);
    h.runtime.reconnecting("t", "g1");
    expect(await h.runtime.connected("t", "g1", verifiedStatus())).toBe(true);
    expect(await h.runtime.admit(call("read_page"), "t")).toBeUndefined();
  });

  it("fails startup when the wrapper never lands, keeping the journal restorable", async () => {
    const h = await setup();
    await h.runtime.prepare(session());
    await writeFile(manifestPath, manifest(wrapperPath));
    expect(await h.runtime.connected("t", "g1", verifiedStatus())).toBe(false);
    expect(h.runtime.status("t", "g1")?.state).toBe("failed");
    const [transaction] = await h.storage.listTransactions("claude");
    expect(transaction).toMatchObject({ state: "launched", launchVerified: false });
  });

  it("admits observed and mutating calls with zero reads while setup is unchanged", async () => {
    const h = await setup();
    await connected(h);
    expect(await h.runtime.admit(call("read_page", {}, { toolUseId: "a" }), "t")).toBeUndefined();
    const reads = h.cache.reads;
    const hashes = h.cache.hashes;
    expect(
      await h.runtime.admit(call("navigate", { url: "https://x" }, { toolUseId: "b" }), "t"),
    ).toBeUndefined();
    expect(
      await h.runtime.admit(call("computer", { action: "left_click" }, { toolUseId: "a" }), "t"),
    ).toBeUndefined();
    expect([h.cache.reads, h.cache.hashes]).toEqual([reads, hashes]);
  });

  it("detects another session rewriting the setup and stays blocked until reconnect", async () => {
    const h = await setup();
    await connected(h);
    await writeFile(manifestPath, manifest("/elsewhere/claude/chrome/chrome-native-host-long"));
    expect(await h.runtime.admit(call("read_page"), "t")).toBe(CLAUDE_IN_CHROME_EXTERNAL_CONFLICT);
    expect(h.runtime.status("t", "g1")?.state).toBe("external-cli-conflict");
    await writeFile(manifestPath, manifest(wrapperPath));
    expect(await h.runtime.admit(call("read_page"), "t")).toBe(CLAUDE_IN_CHROME_EXTERNAL_CONFLICT);
  });

  it("re-inspects after an approval wait even for the same tool use", async () => {
    const h = await setup();
    await connected(h);
    expect(await h.runtime.admit(call("read_page", {}, { toolUseId: "a" }), "t")).toBeUndefined();
    await writeFile(wrapperPath, "#!/bin/sh\nexec /tmp/evil --chrome-native-host\n");
    expect(await h.runtime.admit(call("read_page", {}, { toolUseId: "a" }), "t")).toBeUndefined();
    expect(await h.runtime.admit(call("read_page", {}, { toolUseId: "a", fresh: true }), "t")).toBe(
      CLAUDE_IN_CHROME_EXTERNAL_CONFLICT,
    );
  });

  it.each([
    [
      "policy off",
      (h: Awaited<ReturnType<typeof setup>>) => void (h.state.policy = false),
      "turned off",
    ],
    ["paused", (h: Awaited<ReturnType<typeof setup>>) => void (h.state.paused = true), "paused"],
  ])("denies when %s", async (_name, change, message) => {
    const h = await setup();
    await connected(h);
    change(h);
    expect(await h.runtime.admit(call("read_page"), "t")).toContain(message);
  });

  it("classifies calls closed: lookalikes, unsupported operations and protocol drift", async () => {
    const h = await setup();
    await connected(h);
    expect(await h.runtime.admit(call("read_page", {}, { generation: "g0" }), "t")).toContain(
      "unavailable",
    );
    expect(
      await h.runtime.admit(
        call("read_page", {}, { provenance: { name: "claude-in-chrome", source: "project" } }),
        "t",
      ),
    ).toContain("isn't from Claude's verified");
    expect(await h.runtime.admit(call("file_upload"), "t")).toContain("unsupported-operation");
    expect(await h.runtime.admit(call("computer", { action: "teleport" }), "t")).toContain(
      "unsupported-operation",
    );
    expect(
      await h.runtime.admit(
        call("browser_batch", { actions: [{ name: "browser_batch", input: {} }] }),
        "t",
      ),
    ).toContain("unsupported-operation");
    expect(await h.runtime.admit(call("browser_batch", { actions: "x" }), "t")).toContain(
      "tool protocol",
    );
    expect(h.runtime.status("t", "g1")?.state).toBe("failed");
  });

  it("reports desktop interruption and fails closed at the admission deadline", async () => {
    const validate = vi.fn(async () => {});
    const h = await setup({ validate });
    await connected(h);
    validate.mockRejectedValueOnce(
      new ComputerControlError({ _tag: "Interrupted", message: "x" } as never),
    );
    expect(await h.runtime.admit(call("read_page"), "t")).toContain("interrupted");
    validate.mockImplementationOnce(() => new Promise(() => {}));
    expect(await h.runtime.admit(call("read_page"), "t")).toContain(
      "could not be verified in time",
    );
  });

  it("keeps the restart fingerprint stable across connection health changes", async () => {
    const h = await setup();
    await h.runtime.prepare(session());
    const atStart = h.runtime.fingerprint("t");
    await cliLaunch();
    expect(await h.runtime.connected("t", "g1", verifiedStatus())).toBe(true);
    expect(h.runtime.fingerprint("t")).toBe(atStart);
    expect(await h.runtime.admit(call("browser_batch", { actions: "x" }), "t")).toContain(
      "tool protocol",
    );
    expect(h.runtime.status("t", "g1")?.state).toBe("failed");
    expect(h.runtime.fingerprint("t")).toBe(atStart);
  });

  it("finalizes idempotently and never lets a late finalizer touch a replacement", async () => {
    const h = await setup();
    await connected(h);
    await expect(h.runtime.prepare(session())).rejects.toThrow("already exists");
    await h.runtime.finalize("t", "g0");
    expect(h.runtime.status("t", "g1")?.state).toBe("connected");
    await h.runtime.finalize("t", "g1");
    await h.runtime.finalize("t", "g1");
    expect(h.deps.release).toHaveBeenCalledTimes(1);
    expect(h.runtime.status("t", "g1")).toBeUndefined();
  });
});
