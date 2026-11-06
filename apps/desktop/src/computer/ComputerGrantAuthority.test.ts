import { describe, expect, it } from "vitest";
import { ComputerGrantAuthority } from "./ComputerGrantAuthority";
import { ComputerConsentStore } from "./ComputerConsentStore";
import { createHmac } from "node:crypto";
import { canonicalJson } from "./signedRecordFile";
import type {
  ComputerAccessRequested,
  ComputerAccessAnswer,
  ComputerAuthorization,
} from "@t3tools/contracts";
const request: ComputerAccessRequested = {
  requestId: "r",
  threadId: "t",
  projectId: "p",
  sessionGeneration: "s",
  kind: "apps",
  reason: "Edit",
  apps: [{ appId: "com.apple.TextEdit", name: "TextEdit", tier: "full" }],
};
const answer: ComputerAccessAnswer = {
  requestId: "r",
  backendIncarnation: "b",
  decisions: [{ appId: "com.apple.TextEdit", allow: true, allowTyping: false, remember: true }],
};
const auth: ComputerAuthorization = {
  profileId: "profile",
  projectId: "p",
  threadId: "t",
  sessionGeneration: "s",
  turnId: "turn",
  executionGeneration: 1,
  grantVersion: 1,
  grants: [],
};
function approve(authority: ComputerGrantAuthority, remember = true) {
  const result = authority.issue("profile", request, {
    ...answer,
    decisions: [{ ...answer.decisions[0]!, remember }],
  });
  return {
    appId: "com.apple.TextEdit",
    tier: "full" as const,
    allowTyping: false,
    receipt: result.decisions[0]!.receipt!,
  };
}
describe("desktop consent receipts", () => {
  it("reuses main's remembered receipt across sequential sessions without exhausting the run cap", () => {
    const authority = new ComputerGrantAuthority("darwin");
    let receipt: string | undefined;
    for (let index = 0; index < 10_001; index++) {
      const sessionGeneration = "session-" + index;
      const issued = authority.issue("profile", { ...request, sessionGeneration }, answer);
      receipt ??= issued.decisions[0]!.receipt;
      expect(issued.decisions[0]!.receipt).toBe(receipt);
      authority.sessionClosed("profile", "t", sessionGeneration);
    }
    expect(authority.listRemembered("profile")).toHaveLength(1);
  });
  it("revoking a session policy preserves app grants while revoking an app removes every receipt", () => {
    const authority = new ComputerGrantAuthority("darwin");
    const grant = approve(authority);
    authority.validate({ ...auth, grants: [grant] });
    authority.revoke(
      "profile",
      { version: 1, kind: "session-actions", projectId: "p", background: true, policyVersion: 1 },
      new Set(["t"]),
    );
    expect(authority.listRemembered("profile")).toHaveLength(1);
    const affected = authority.revoke("profile", {
      version: 1,
      kind: "app-access",
      projectId: "p",
      appId: grant.appId,
      tier: grant.tier,
      allowTyping: false,
      policyVersion: 1,
    });
    expect(affected[0]?.grants).toEqual([]);
    expect(authority.validate({ ...auth, grants: [grant] }).grants).toEqual([]);
    expect(authority.listRemembered("profile")).toEqual([]);
  });
  it("restores more than 10,000 policies without crashing or consuming the session budget", () => {
    const key = Buffer.alloc(32, 7);
    const profiles: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 10_001; i++) {
      const profileId = "profile-" + Math.floor(i / 2000);
      const record = {
        version: 1,
        kind: "app-access",
        projectId: "p",
        appId: "app-" + i,
        tier: "full",
        allowTyping: false,
        policyVersion: 1,
      };
      const mac = createHmac("sha256", key)
        .update(canonicalJson(["f5-native-computer-consent-v1", profileId, record]))
        .digest("hex");
      (profiles[profileId] ??= {})[canonicalJson(["app-access", "p", record.appId])] = {
        ...record,
        mac,
      };
    }
    const store = new ComputerConsentStore(
      {
        read: () => JSON.stringify(profiles),
        write: () => {},
        remove: () => {},
      },
      () => key,
    );
    const authority = new ComputerGrantAuthority("darwin", store);
    expect(authority.listRemembered("profile-5")).toHaveLength(1);
    expect(approve(authority).receipt).toBeTruthy();
  });

  it("forgets restored policies in memory and on disk, even if the disk later fails", () => {
    let contents: string | undefined;
    let fail = false;
    const io = {
      read: () => contents,
      write: (value: string) => {
        if (fail) throw new Error("disk full");
        contents = value;
      },
      remove: () => {
        if (fail) throw new Error("read-only");
        contents = undefined;
      },
    };
    const store = new ComputerConsentStore(io, () => Buffer.alloc(32, 7));
    const policy = {
      version: 1 as const,
      kind: "app-access" as const,
      projectId: "p",
      appId: "com.apple.TextEdit",
      tier: "full" as const,
      allowTyping: false,
      policyVersion: 1 as const,
    };
    store.allow("profile", policy);
    const authority = new ComputerGrantAuthority("darwin", store);
    const [grant] = authority.listRemembered("profile");
    fail = true;
    expect(() => authority.forget("profile", "p", policy.appId)).toThrow("restart could restore");
    expect(authority.listRemembered("profile")).toEqual([]);
    expect(authority.validate({ ...auth, grants: [grant!] }).grants).toEqual([]);
    fail = false;
    // Retry reaches disk even though the record was already removed from memory.
    authority.forget("profile", "p", policy.appId);
    expect(
      new ComputerGrantAuthority(
        "darwin",
        new ComputerConsentStore(io, () => Buffer.alloc(32, 7)),
      ).listRemembered("profile"),
    ).toEqual([]);
  });
  it("drops persisted policy whose tier is no longer permitted on this platform", () => {
    let contents: string | undefined;
    const store = new ComputerConsentStore(
      {
        read: () => contents,
        write: (value) => {
          contents = value;
        },
        remove: () => {
          contents = undefined;
        },
      },
      () => Buffer.alloc(32, 7),
    );
    store.allow("profile", {
      version: 1,
      kind: "app-access",
      projectId: "p",
      appId: "com.apple.Terminal",
      tier: "full",
      allowTyping: false,
      policyVersion: 1,
    });
    expect(new ComputerGrantAuthority("darwin", store).listRemembered("profile")).toEqual([]);
  });

  it("hydrates signed policy with fresh receipts without persisting issue()", () => {
    let contents: string | undefined;
    const io = {
      read: () => contents,
      write: (value: string) => {
        contents = value;
      },
      remove: () => {
        contents = undefined;
      },
    };
    const store = new ComputerConsentStore(io, () => Buffer.alloc(32, 7));
    const authority = new ComputerGrantAuthority("darwin", store);
    approve(authority);
    expect(store.list("profile")).toEqual([]);
    store.allow("profile", {
      version: 1,
      kind: "app-access",
      projectId: "p",
      appId: "com.apple.TextEdit",
      tier: "full",
      allowTyping: false,
      policyVersion: 1,
    });
    const first = new ComputerGrantAuthority("darwin", store).listRemembered("profile", "p");
    const next = new ComputerGrantAuthority(
      "darwin",
      new ComputerConsentStore(io, () => Buffer.alloc(32, 7)),
    );
    expect(first).toHaveLength(1);
    expect(next.listRemembered("profile", "p")[0]!.receipt).not.toBe(first[0]!.receipt);
    expect(next.remembered("profile", "p", first)).toEqual([]);
    expect(next.listRemembered("other")).toEqual([]);
  });

  it("reclaims receipts across more than 10,000 sequential session lifecycles", () => {
    const authority = new ComputerGrantAuthority("darwin");
    for (let index = 0; index < 10_001; index++) {
      const grant = approve(authority, false);
      authority.validate({ ...auth, grants: [grant] });
      authority.sessionClosed("profile", "t", "s");
      expect(authority.validate({ ...auth, grants: [grant] }).grants).toEqual([]);
    }
  });

  it("refuses file-forged grants and stale receipts after F5 restarts", () => {
    const authority = new ComputerGrantAuthority("darwin");
    const grant = approve(authority);
    expect(
      authority.validate({
        ...auth,
        grants: [{ appId: grant.appId, tier: "full", allowTyping: false }],
      }).grants,
    ).toEqual([]);
    expect(authority.remembered("profile", "p", [grant])).toEqual([grant]);
    expect(new ComputerGrantAuthority("darwin").remembered("profile", "p", [grant])).toEqual([]);
  });
  it("binds approval to identity, tier, typing, profile and project", () => {
    const authority = new ComputerGrantAuthority("darwin");
    const grant = approve(authority);
    expect(authority.validate({ ...auth, grants: [grant] }).grants).toEqual([grant]);
    for (const invalid of [
      { ...grant, appId: "com.apple.Safari" },
      { ...grant, allowTyping: true },
    ])
      expect(authority.validate({ ...auth, grants: [invalid] }).grants).toEqual([]);
    expect(authority.remembered("other", "p", [grant])).toEqual([]);
    expect(authority.remembered("profile", "other", [grant])).toEqual([]);
  });
  it("keeps session approvals within the generation and remembered approvals across backend restart", () => {
    const authority = new ComputerGrantAuthority("darwin");
    const session = approve(authority, false);
    expect(
      authority.validate({ ...auth, sessionGeneration: "new", grants: [session] }).grants,
    ).toEqual([]);
    const remembered = approve(authority);
    authority.disconnect("profile");
    expect(authority.remembered("profile", "p", [remembered, session])).toEqual([remembered]);
  });
  it("cannot replay a receipt revoked in the same session", () => {
    const authority = new ComputerGrantAuthority("darwin");
    const grant = approve(authority);
    authority.validate({ ...auth, grants: [grant] });
    authority.validate(auth);
    expect(authority.validate({ ...auth, grants: [grant] }).grants).toEqual([]);
    const fresh = approve(authority);
    expect(authority.validate({ ...auth, grants: [fresh] }).grants).toEqual([fresh]);
  });
});

it("cannot restore a forgotten project receipt from the grants file", () => {
  const authority = new ComputerGrantAuthority("darwin");
  const grant = approve(authority);
  authority.validate({ ...auth, grants: [grant] });
  authority.forget("profile", "p", grant.appId);
  expect(authority.remembered("profile", "p", [grant])).toEqual([]);
  expect(authority.validate({ ...auth, grants: [grant] }).grants).toEqual([grant]);
  expect(
    authority.validate({ ...auth, sessionGeneration: "future", grants: [grant] }).grants,
  ).toEqual([]);
});
