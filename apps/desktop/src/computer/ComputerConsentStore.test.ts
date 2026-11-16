import { createHmac } from "node:crypto";
import type { RememberedComputerConsent } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { ComputerConsentStore, computerConsentKey } from "./ComputerConsentStore";
import { canonicalJson } from "./signedRecordFile";

const KEY = Buffer.alloc(32, 7);
const app: RememberedComputerConsent = {
  version: 1,
  kind: "app-access",
  projectId: "project",
  appId: "app",
  tier: "click",
  allowTyping: false,
  policyVersion: 1,
};

function memory() {
  const state = { contents: undefined as string | undefined, failWrite: false, failRemove: false };
  return {
    state,
    io: {
      read: () => state.contents,
      write: (contents: string) => {
        if (state.failWrite) throw new Error("disk full");
        state.contents = contents;
      },
      remove: () => {
        if (state.failRemove) throw new Error("read-only");
        state.contents = undefined;
      },
    },
  };
}

describe("ComputerConsentStore", () => {
  it("retains every profile's signed policy across writes while the keychain is unavailable", () => {
    const { io, state } = memory();
    const signed = new ComputerConsentStore(io, () => KEY);
    signed.allow("p1", app);
    signed.allow("p2", { ...app, projectId: "other" });
    const before = JSON.parse(state.contents!);
    let available = false;
    let keyReads = 0;
    const reloaded = new ComputerConsentStore(io, () => {
      keyReads++;
      return available ? KEY : undefined;
    });
    expect(keyReads).toBe(0);
    expect(reloaded.list("p1")).toEqual([]);
    // A native run-only replacement must not erase the previous durable envelope.
    expect(reloaded.allow("p1", { ...app, allowTyping: true })).toBe("session-only");
    expect(reloaded.list("p1")).toEqual([{ ...app, allowTyping: true }]);
    reloaded.revoke("unrelated", app);
    expect(JSON.parse(state.contents!).p1).toEqual(before.p1);
    expect(JSON.parse(state.contents!).p2).toEqual(before.p2);
    expect(reloaded.allow("run-only", app)).toBe("session-only");
    available = true;
    reloaded.allow("p3", app);
    const restart = new ComputerConsentStore(io, () => KEY);
    expect(restart.list("p1")).toEqual([app]);
    expect(restart.list("p2")).toEqual([{ ...app, projectId: "other" }]);
    expect(restart.list("run-only")).toEqual([]);
  });
  it("round trips every policy kind, replacing only the same policy key", () => {
    const { io } = memory();
    const records: RememberedComputerConsent[] = [
      app,
      {
        version: 1,
        kind: "session-actions",
        projectId: "project",
        background: true,
        policyVersion: 1,
      },
      { version: 1, kind: "full-access-session", policyVersion: 1 },
      { version: 1, kind: "takeover", projectId: "project", appId: "app", policyVersion: 1 },
    ];
    const store = new ComputerConsentStore(io, () => KEY);
    for (const record of records) expect(store.allow("profile", record)).toBe("durable");
    expect(new ComputerConsentStore(io, () => KEY).list("profile")).toEqual(records);
    store.allow("profile", { ...app, allowTyping: true });
    expect(store.list("profile")).toHaveLength(4);
    expect(store.list("profile")[0]).toEqual({ ...app, allowTyping: true });
    expect(store.list("other")).toEqual([]);
  });

  it("rejects forged, edited, cross-profile and stale-policy records", () => {
    const { io, state } = memory();
    new ComputerConsentStore(io, () => KEY).allow("profile", app);
    const saved = state.contents!;
    for (const contents of [
      saved.replace('"allowTyping":false', '"allowTyping":true'),
      saved.replace('"profile":', '"other":'),
      saved.replace('"policyVersion":1', '"policyVersion":2'),
      saved.replace('"version":1', '"version":2'),
      saved.replace(/"mac":"[^"]+"/, '"mac":"unsigned"'),
      saved.replace(/"mac":"[^"]+"/, '"mac":"' + "é".repeat(64) + '"'),
      "{",
      "[]",
    ]) {
      state.contents = contents;
      const store = new ComputerConsentStore(io, () => KEY);
      expect(store.list("profile")).toEqual([]);
      expect(store.list("other")).toEqual([]);
    }
    state.contents = saved;
    expect(new ComputerConsentStore(io, () => undefined).list("profile")).toEqual([]);
  });

  it("ignores even signed invalid field combinations and unknown policy versions", () => {
    const { io, state } = memory();
    for (const record of [
      { ...app, receipt: "not-policy" },
      { ...app, version: 2 },
      { ...app, policyVersion: 2 },
      { ...app, tier: "view", allowTyping: true },
      { ...app, tier: ["click"] },
      { ...app, kind: "unknown" },
    ]) {
      const mac = createHmac("sha256", KEY)
        .update(canonicalJson(["f5-native-computer-consent-v1", "profile", record]))
        .digest("hex");
      state.contents = JSON.stringify({
        profile: { [computerConsentKey(app)]: { ...record, mac } },
      });
      expect(new ComputerConsentStore(io, () => KEY).list("profile")).toEqual([]);
    }
  });

  it("uses canonical sorted keys and never exposes mutable stored records", () => {
    expect(canonicalJson({ z: [{ b: 1, a: 2 }], a: 0 })).toBe('{"a":0,"z":[{"a":2,"b":1}]}');
    const { io } = memory();
    const store = new ComputerConsentStore(io, () => KEY);
    const record = { ...app };
    store.allow("profile", record);
    Object.assign(record, { allowTyping: true });
    Object.assign(store.list("profile")[0]!, { allowTyping: true });
    expect(store.list("profile")[0]).toEqual(app);
  });

  it("keeps failed writes and missing-key grants for this run only", () => {
    for (const noKey of [false, true]) {
      const { io, state } = memory();
      state.failWrite = true;
      const store = new ComputerConsentStore(io, () => (noKey ? undefined : KEY));
      expect(store.allow("profile", app)).toBe("session-only");
      expect(store.list("profile")).toEqual([app]);
      expect(new ComputerConsentStore(io, () => KEY).list("profile")).toEqual([]);
    }
  });

  it("revokes in memory first, deletes on rewrite failure, and reports failure of both", () => {
    const { io, state } = memory();
    const store = new ComputerConsentStore(io, () => KEY);
    store.allow("profile", app);
    state.failWrite = true;
    state.failRemove = true;
    expect(() => store.revoke("profile", app)).toThrow("restart could restore");
    expect(store.list("profile")).toEqual([]);
    state.failRemove = false;
    store.revoke("profile", app);
    expect(new ComputerConsentStore(io, () => KEY).list("profile")).toEqual([]);
  });
});
