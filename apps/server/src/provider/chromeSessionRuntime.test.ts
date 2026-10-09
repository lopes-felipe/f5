import { describe, expect, it, vi } from "vitest";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import { ChromeSessionRuntime } from "./chromeSessionRuntime";
import { parseNativeHostManifest, type ChromeNativeHostTransaction } from "./chromeNativeHost";
const manifest = (path: string) =>
  JSON.stringify({ name: "certified-test-host", type: "stdio", path, allowed_origins: [] });
const session = { threadId: "thread", generation: "generation", providerHome: "/profile" };
function setup(certified = true) {
  let registrations = [parseNativeHostManifest("chrome", "user", manifest("/foreign"))];
  let paused = false;
  const saved = new Map<string, ChromeNativeHostTransaction>();
  const release = vi.fn();
  const acquire = vi.fn(async () => {});
  const consent = vi.fn(async () => true);
  const validate = vi.fn(async () => {});
  const restoreRegistration = vi.fn(async () => {});
  const runtime = new ChromeSessionRuntime({
    descriptor: {
      provider: "claude",
      certified,
      hostNames: ["certified-test-host"],
      browsers: ["chrome"],
      expectedTarget: (home) => `${home}/host`,
    },
    profileId: "profile",
    acquire,
    validate,
    release,
    consent,
    paused: () => paused,
    storage: {
      inspect: async () => registrations,
      saveTransaction: async (entry) => {
        saved.set(entry.id, entry);
      },
      restoreRegistration,
      listTransactions: async () => [...saved.values()],
      loadTransaction: async (_provider, id) => saved.get(id),
    },
  });
  return {
    runtime,
    validate,
    release,
    acquire,
    consent,
    restoreRegistration,
    saved,
    setRegistrations: (value: typeof registrations) => {
      registrations = value;
    },
    pause: () => {
      paused = true;
    },
  };
}
describe("certified Chrome session runtime", () => {
  it("does nothing while its gate is closed", async () => {
    const h = setup(false);
    expect(await h.runtime.prepare(session, true)).toEqual({ kind: "off" });
    expect(h.acquire).not.toHaveBeenCalled();
    expect(h.consent).not.toHaveBeenCalled();
    expect(h.saved.size).toBe(0);
  });
  it("requires trusted consent before launch and verifies registration before tools", async () => {
    const h = setup();
    expect(await h.runtime.prepare(session, true)).toMatchObject({ kind: "launch" });
    expect(h.consent).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ previousTargets: ["/foreign"], targetPath: "/profile/host" }),
    );
    h.setRegistrations([parseNativeHostManifest("chrome", "user", manifest("/profile/host"))]);
    expect(await h.runtime.beforeTool("thread", "generation", true)).toBeUndefined();
    expect([...h.saved.values()][0]?.state).toBe("launched");
    expect(await h.runtime.beforeTool("thread", "generation", false)).toContain("turned off");
    h.pause();
    expect(await h.runtime.beforeTool("thread", "generation", true)).toContain("paused");
    h.runtime.release("thread", "old-generation");
    expect(h.release).not.toHaveBeenCalled();
    h.runtime.release("thread", "generation");
    expect(h.release).toHaveBeenCalledOnce();
  });
  it("rejects post-launch drift for the whole session and restores only unchanged entries", async () => {
    const h = setup();
    await h.runtime.prepare(session, true);
    h.setRegistrations([parseNativeHostManifest("chrome", "user", manifest("/profile/host"))]);
    await h.runtime.beforeTool("thread", "generation", true);
    const fingerprint = h.runtime.fingerprint("thread");
    h.setRegistrations([parseNativeHostManifest("chrome", "user", manifest("/external-change"))]);
    expect(await h.runtime.beforeTool("thread", "generation", true)).toContain("changed");
    expect(h.runtime.fingerprint("thread")).not.toBe(fingerprint);
    const stop = vi.fn(async () => {
      h.runtime.release("thread", "generation");
    });
    const result = await h.runtime.restore([...h.saved.keys()][0]!, stop);
    expect(stop).toHaveBeenCalledOnce();
    expect(result.skipped).toEqual(["user"]);
    expect(h.restoreRegistration).not.toHaveBeenCalled();
  });
  it("honors main's veto without poisoning a paused session", async () => {
    const h = setup();
    await h.runtime.prepare(session, true);
    h.setRegistrations([parseNativeHostManifest("chrome", "user", manifest("/profile/host"))]);
    await h.runtime.connected("thread", "generation");
    const fingerprint = h.runtime.fingerprint("thread");
    h.validate.mockRejectedValueOnce(
      new ComputerControlError({ _tag: "Interrupted", cause: "paused" }),
    );
    expect(await h.runtime.beforeTool("thread", "generation", true)).toContain("interrupted");
    expect(h.runtime.fingerprint("thread")).toBe(fingerprint);
    expect(await h.runtime.beforeTool("thread", "generation", true)).toBeUndefined();
  });
  it("unreadable setup cannot launch or write a transaction", async () => {
    const h = setup();
    h.setRegistrations([{ browser: "chrome", location: "user", state: "unreadable" }]);
    expect(await h.runtime.prepare(session, true)).toMatchObject({ kind: "unknown" });
    expect(h.consent).not.toHaveBeenCalled();
    expect(h.saved.size).toBe(0);
    expect(h.release).toHaveBeenCalledOnce();
  });
  it("rejects restoration from another profile before stopping or writing", async () => {
    const h = setup();
    await h.runtime.prepare(session, true);
    const entry = [...h.saved.values()][0]!;
    h.saved.set(entry.id, { ...entry, profileId: "another-profile" });
    const stop = vi.fn(async () => {});
    await expect(h.runtime.restore(entry.id, stop)).rejects.toThrow("does not belong");
    expect(stop).not.toHaveBeenCalled();
    expect(h.restoreRegistration).not.toHaveBeenCalled();
  });
  it("denial releases the device without changing registration or granting computer actions", async () => {
    const h = setup();
    h.consent.mockResolvedValue(false);
    expect(await h.runtime.prepare(session, true)).toEqual({ kind: "off" });
    expect(h.saved.size).toBe(0);
    expect(h.release).toHaveBeenCalledOnce();
  });
  it("detects setup changing while consent is pending", async () => {
    const h = setup();
    h.consent.mockImplementation(async () => {
      h.setRegistrations([parseNativeHostManifest("chrome", "user", manifest("/drift"))]);
      return true;
    });
    await expect(h.runtime.prepare(session, true)).rejects.toThrow("changed");
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.saved.size).toBe(0);
  });
  it("restores exact original bytes under a lease after stopping owning sessions", async () => {
    const h = setup();
    await h.runtime.prepare(session, true);
    h.setRegistrations([parseNativeHostManifest("chrome", "user", manifest("/profile/host"))]);
    await h.runtime.beforeTool("thread", "generation", true);
    const id = [...h.saved.keys()][0]!;
    await h.runtime.restore(id, async () => h.runtime.release("thread", "generation"));
    expect(h.restoreRegistration).toHaveBeenCalledWith("user", manifest("/foreign"));
    expect(h.acquire).toHaveBeenCalledTimes(2);
    expect(h.release).toHaveBeenCalledTimes(2);
    await h.runtime.restore(id, async () => {});
    expect(h.restoreRegistration).toHaveBeenCalledOnce();
  });
});
