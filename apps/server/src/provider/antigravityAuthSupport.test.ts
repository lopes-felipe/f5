import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  advanceAntigravityRevision,
  antigravityKeyFingerprint,
  antigravityLaunchEnvironment,
  antigravityProfileSettings,
  antigravityReadiness,
  readAntigravityAuthState,
  reconcileAntigravityAuthState,
  redactAntigravityKey,
  updateAntigravityAuthState,
} from "./antigravityAuthSupport.ts";

const directories: string[] = [];
const profile = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "f5-agy-auth-"));
  directories.push(directory);
  return directory;
};
const writeToken = async (directory: string, contents: Record<string, string>) => {
  await fs.mkdir(path.join(directory, "antigravity-acp"), { recursive: true });
  await fs.writeFile(
    path.join(directory, "antigravity-acp", "acp_token.json"),
    JSON.stringify(contents),
  );
};
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const KEY = "AIzaSyExampleKey000000000000";

describe("Antigravity launch environment", () => {
  const base = {
    PATH: "/bin",
    GEMINI_API_KEY: "host-key",
    gemini_api_key: "host-key-lower",
    GOOGLE_API_KEY: "host-google",
    GOOGLE_APPLICATION_CREDENTIALS: "/adc.json",
    GOOGLE_CLOUD_PROJECT: "p",
    GOOGLE_CLOUD_LOCATION: "l",
    GOOGLE_CLOUD_QUOTA_PROJECT: "q",
    GCLOUD_PROJECT: "g",
    CLOUDSDK_CORE_PROJECT: "c",
    AGY_ACP_ENABLE_OAUTH: "1",
  };
  it("strips every inherited credential and project selector for the Google account method", () => {
    const env = antigravityLaunchEnvironment({
      base,
      home: "/profile",
      harness: undefined,
      browserCommand: "helper",
      auth: { authMethod: "oauth-personal", apiKey: KEY },
    });
    for (const key of Object.keys(base).filter((key) => key !== "PATH"))
      expect(env[key], key).toBeUndefined();
    expect(env.PATH).toBe("/bin");
    expect(env.GEMINI_HOME).toBe("/profile");
    expect(env.SSH_CONNECTION).toBeTruthy();
  });
  it("re-adds only the configured key for the key method, never the host's", () => {
    const env = antigravityLaunchEnvironment({
      base,
      home: "/profile",
      harness: undefined,
      browserCommand: "helper",
      auth: { authMethod: "gemini-api-key", apiKey: KEY },
    });
    expect(env.GEMINI_API_KEY).toBe(KEY);
    expect(env.GOOGLE_API_KEY).toBeUndefined();
    expect(env.SSH_CONNECTION).toBeUndefined();
    const keyless = antigravityLaunchEnvironment({
      base,
      home: "/profile",
      harness: undefined,
      browserCommand: "helper",
      auth: { authMethod: "gemini-api-key", apiKey: "" },
    });
    expect(keyless.GEMINI_API_KEY).toBeUndefined();
  });
  it("names the method in settings.json without any credential", () => {
    const text = antigravityProfileSettings({ authMethod: "gemini-api-key", apiKey: KEY });
    expect(JSON.parse(text)).toEqual({ auth: { type: "gemini-api-key" } });
    expect(text).not.toContain(KEY);
  });
  it("redacts the key from diagnostics", () => {
    expect(redactAntigravityKey(`failed with ${KEY}`, KEY)).toBe("failed with [API key redacted]");
  });
});

describe("Antigravity readiness", () => {
  it("is ready for the Google account method when the token file is non-empty", async () => {
    const directory = await profile();
    const auth = { authMethod: "oauth-personal" as const, apiKey: "" };
    expect((await antigravityReadiness({ profileDirectory: directory, auth })).action).toBe(
      "Sign in",
    );
    await writeToken(directory, { client_id: "c", refresh_token: "r" });
    expect((await antigravityReadiness({ profileDirectory: directory, auth })).ready).toBe(true);
  });
  it("never treats a leftover token as a verified key", async () => {
    const directory = await profile();
    await writeToken(directory, { client_id: "c", refresh_token: "r" });
    const auth = { authMethod: "gemini-api-key" as const, apiKey: KEY };
    const readiness = await antigravityReadiness({ profileDirectory: directory, auth });
    expect(readiness.ready).toBe(false);
    expect(readiness.action).toBe("Connect");
    expect(readiness.message).toBe("Connect to verify this key.");
    await updateAntigravityAuthState(directory, (state) => ({
      ...state,
      method: "gemini-api-key",
      keyFingerprint: antigravityKeyFingerprint(KEY),
      verified: true,
    }));
    expect((await antigravityReadiness({ profileDirectory: directory, auth })).ready).toBe(true);
    // A rotated key needs a new connect.
    expect(
      (
        await antigravityReadiness({
          profileDirectory: directory,
          auth: { ...auth, apiKey: `${KEY}x` },
        })
      ).ready,
    ).toBe(false);
  });
  it("asks for re-entry when the stored key reference is broken", async () => {
    const readiness = await antigravityReadiness({
      profileDirectory: await profile(),
      auth: { authMethod: "gemini-api-key", apiKey: "" },
      keyUnavailable: true,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.message).toContain("Re-enter");
  });
  it("refuses methods F5 does not expose yet", async () => {
    const readiness = await antigravityReadiness({
      profileDirectory: await profile(),
      auth: { authMethod: "oauth-business", apiKey: "" },
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.message).toContain("not available");
  });
});

describe("Antigravity account revision", () => {
  it("records the first method without advancing, so existing threads keep resuming", async () => {
    const directory = await profile();
    const state = await reconcileAntigravityAuthState(directory, {
      authMethod: "oauth-personal",
      apiKey: "",
    });
    expect(state.revision).toBe(0);
    expect(state.method).toBe("oauth-personal");
  });
  it("advances on method change, key change and OAuth account change", async () => {
    const directory = await profile();
    await writeToken(directory, { client_id: "c", refresh_token: "r1" });
    await reconcileAntigravityAuthState(directory, { authMethod: "oauth-personal", apiKey: "" });
    await writeToken(directory, { client_id: "c", refresh_token: "r2" });
    expect(
      (await reconcileAntigravityAuthState(directory, { authMethod: "oauth-personal", apiKey: "" }))
        .revision,
    ).toBe(1);
    expect(
      (
        await reconcileAntigravityAuthState(directory, {
          authMethod: "gemini-api-key",
          apiKey: KEY,
        })
      ).revision,
    ).toBe(2);
    expect(
      (
        await reconcileAntigravityAuthState(directory, {
          authMethod: "gemini-api-key",
          apiKey: KEY,
        })
      ).revision,
    ).toBe(2);
    const rotated = await reconcileAntigravityAuthState(directory, {
      authMethod: "gemini-api-key",
      apiKey: `${KEY}2`,
    });
    expect(rotated.revision).toBe(3);
    expect(rotated.verified).toBe(false);
  });
  it("never lowers the revision and serializes concurrent writers", async () => {
    const directory = await profile();
    await Promise.all(Array.from({ length: 5 }, () => advanceAntigravityRevision(directory)));
    expect((await readAntigravityAuthState(directory)).revision).toBe(5);
    await updateAntigravityAuthState(directory, (state) => ({ ...state, revision: 0 }));
    expect((await readAntigravityAuthState(directory)).revision).toBe(5);
  });
  it("refuses to write over an unreadable state instead of restarting at revision zero", async () => {
    const directory = await profile();
    await fs.writeFile(path.join(directory, "f5-auth-state.json"), "{not json");
    await expect(advanceAntigravityRevision(directory)).rejects.toThrow(/could not be read/);
    expect(await fs.readFile(path.join(directory, "f5-auth-state.json"), "utf8")).toBe("{not json");
    // Status reads still fall back to an unready state.
    expect((await readAntigravityAuthState(directory)).verified).toBe(false);
  });
  it("reports a failed write to the caller without an unhandled rejection", async () => {
    const directory = await profile();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // A directory where the state file should be makes the rename fail.
      await fs.mkdir(path.join(directory, "f5-auth-state.json", "blocker"), { recursive: true });
      await expect(advanceAntigravityRevision(directory)).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      // The queue recovers for the next writer.
      await fs.rm(path.join(directory, "f5-auth-state.json"), { recursive: true });
      expect((await advanceAntigravityRevision(directory)).revision).toBe(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
  it("keeps the last account while the token is unreadable, so a new account still advances", async () => {
    const directory = await profile();
    const oauth = { authMethod: "oauth-personal", apiKey: "" } as const;
    await writeToken(directory, { client_id: "c", refresh_token: "account-a" });
    await reconcileAntigravityAuthState(directory, oauth);
    await fs.rm(path.join(directory, "antigravity-acp", "acp_token.json"));
    expect((await reconcileAntigravityAuthState(directory, oauth)).revision).toBe(0);
    await writeToken(directory, { client_id: "c", refresh_token: "account-b" });
    expect((await reconcileAntigravityAuthState(directory, oauth)).revision).toBe(1);
    // The same account coming back keeps its revision.
    expect((await reconcileAntigravityAuthState(directory, oauth)).revision).toBe(1);
  });
  it("removes fields a revision patch sets to undefined", async () => {
    const directory = await profile();
    await updateAntigravityAuthState(directory, (state) => ({
      ...state,
      keyFingerprint: "k",
      accountFingerprint: "a",
      verified: true,
    }));
    const state = await advanceAntigravityRevision(directory, () => ({
      keyFingerprint: undefined,
      accountFingerprint: undefined,
      verified: false,
    }));
    expect(state).toEqual({ version: 1, revision: 1, verified: false });
  });
});
