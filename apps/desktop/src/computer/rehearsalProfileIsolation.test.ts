import { expect, it } from "vitest";
import {
  RehearsalProfileIsolation,
  profileProviderProgress,
  profileOwnerLeaseReady,
  profileSnapshotEnvelope,
} from "./rehearsalProfileIsolation";

it("separates observer faults from transport failure without retaining exception contents", () => {
  const snapshot = { traceComplete: true };
  expect(profileSnapshotEnvelope(() => snapshot)).toEqual({
    failed: false,
    value: JSON.stringify(snapshot),
  });
  expect(profileSnapshotEnvelope(() => undefined)).toEqual({ failed: true });
  const failed = profileSnapshotEnvelope(() => {
    throw new Error("PRIVATE_SENTINEL");
  });
  expect(failed).toEqual({ failed: true });
  expect(JSON.stringify(failed)).not.toContain("PRIVATE");
});

it("preserves full-budget observation fields and fails closed on oversized or circular snapshots", () => {
  const snapshot = {
    traceComplete: false,
    profiles: [0, 1].map(() => ({
      foreignImages: true,
      native: {
        operations: Array.from({ length: 1024 }, () => ({
          op: "inspect",
          outcome: "ok",
          accessible: true,
          nodes: 20,
        })),
      },
    })),
  };
  const envelope = profileSnapshotEnvelope(() => snapshot);
  expect(envelope.failed).toBe(false);
  if (!envelope.failed) expect(JSON.parse(envelope.value)).toEqual(snapshot);
  expect(profileSnapshotEnvelope(() => "x".repeat(512 * 1024))).toEqual({ failed: true });
  expect(profileSnapshotEnvelope(() => "Ω".repeat(256 * 1024))).toEqual({ failed: true });
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  expect(profileSnapshotEnvelope(() => cyclic)).toEqual({ failed: true });
});

it("rechecks the live lease when a terminal projection crosses acquisition", async () => {
  let held = false;
  let reads = 0;
  const ready = await profileOwnerLeaseReady(
    async () => {
      reads++;
      return held;
    },
    async () => {
      held = true;
      return { turnId: "new", state: "completed" };
    },
    "old",
  );
  expect(ready).toBe(true);
  expect(reads).toBe(2);
});

it.each(["completed", "error", "interrupted"])(
  "still refuses a %s owner turn with no live lease",
  async (state) => {
    await expect(
      profileOwnerLeaseReady(
        async () => false,
        async () => ({ turnId: "new", state }),
        "old",
      ),
    ).rejects.toThrow("Isolation owner turn ended without a lease.");
  },
);

it("waits for the new turn and never treats an old completed turn as failure", async () => {
  for (const turn of [
    undefined,
    { turnId: "old", state: "completed" },
    { turnId: "new", state: "running" },
  ])
    expect(
      await profileOwnerLeaseReady(
        async () => false,
        async () => turn,
        "old",
      ),
    ).toBe(false);
});

const identities = [0, 1].map((i) => ({
  profileId: String(i + 1).repeat(32),
  threadId: `PRIVATE_THREAD_${i}`,
  appId: `private.fixture.${i}`,
  privateTitle: `PRIVATE_TITLE_${i}`,
}));
const configured = () => {
  const o = new RehearsalProfileIsolation();
  o.configure(identities);
  return o;
};
const holder = (i: number) => ({
  profileId: identities[i]!.profileId,
  threadId: identities[i]!.threadId,
  sessionGeneration: `session-${i}`,
  turnId: `turn-${i}`,
  executionGeneration: 1,
  grantVersion: 1,
  grants: [],
  backend: "native",
  threadTitle: identities[i]!.privateTitle,
});
const activity = (i: number) => ({
  threadId: identities[i]!.threadId,
  backend: "native",
  op: "activateApp",
  status: "completed",
  thumbnailDataUrl: "PRIVATE_IMAGE_BYTES",
});
it("preserves fixed pre-host provider progress and pending approval counts without messages", () => {
  const result = profileProviderProgress(
    {
      runtimeMode: "full-access",
      latestTurn: { state: "running", text: "PRIVATE_SENTINEL" },
      session: { lastError: "PRIVATE_SENTINEL" },
    },
    [{ kind: "approval.requested", turnId: "PRIVATE_TURN", payload: { text: "PRIVATE_PROMPT" } }],
  );
  expect(result).toMatchObject({
    threadObserved: true,
    runtimeMode: "full-access",
    turnState: "running",
    activityCounts: { observed: true, turns: [{ approvalsRequested: 1, approvalsResolved: 0 }] },
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(profileProviderProgress(undefined, undefined)).toMatchObject({
    threadObserved: false,
    turnState: "unknown",
    activityCounts: { observed: false },
  });
});
it("correlates both IPC directions and client observations without retaining identities or pixels", () => {
  const o = configured();
  o.receive(identities[0]!.profileId, { type: "leaseChanged", holder: holder(0) }, "main");
  o.receive(
    identities[1]!.profileId,
    { type: "leaseChanged", holder: null, otherProfile: true },
    "main",
  );
  o.receive(
    identities[1]!.profileId,
    { type: "response", requestId: "opaque", error: { _tag: "Busy", holder: "other-profile" } },
    "main",
  );
  o.receive(identities[0]!.profileId, { type: "activity", activity: activity(0) }, "main");
  o.push(0, "computer.activity", activity(0));
  o.push(0, "computer.access.grantsChanged", {
    threadId: identities[0]!.threadId,
    grants: [{ appId: identities[0]!.appId }],
  });
  const s = o.snapshot();
  expect(s.traceComplete).toBe(true);
  expect(s.profiles[0]).toMatchObject({
    ownImages: 1,
    ownWsImages: 1,
    foreignImages: false,
    foreignGrants: false,
  });
  expect(s.profiles[1]).toMatchObject({ anonymousBanners: 1, busy: 1, busyWhileForeignHeld: true });
  expect(JSON.stringify(s)).not.toContain("PRIVATE");
  expect(JSON.stringify(s)).not.toContain("private.fixture");
});
it.each(["ipc", "websocket"])(
  "detects a foreign thumbnail on %s before discarding it",
  (channel) => {
    const o = configured();
    if (channel === "ipc")
      o.receive(identities[1]!.profileId, { type: "activity", activity: activity(0) }, "main");
    else o.push(1, "computer.activity", activity(0));
    expect(o.snapshot().profiles[1]).toMatchObject({
      foreignActivity: true,
      foreignImages: true,
      foreignIdentity: true,
    });
    expect(JSON.stringify(o.snapshot())).not.toContain("PRIVATE");
  },
);
it("rejects named cross-profile banners and grant contents", () => {
  const o = configured();
  o.receive(
    identities[1]!.profileId,
    { type: "leaseChanged", holder: holder(0), otherProfile: true },
    "main",
  );
  o.push(1, "agent.computerUseChanged", {
    threadId: null,
    otherProfile: true,
    title: "PRIVATE_TITLE_0",
  });
  o.push(1, "computer.access.grantsChanged", {
    threadId: identities[1]!.threadId,
    grants: [{ appId: identities[0]!.appId }],
  });
  expect(o.snapshot().profiles[1]).toMatchObject({
    invalidBanner: true,
    foreignIdentity: true,
    foreignGrants: true,
  });
});
it("does not count contention when no foreign holder was observed", () => {
  const o = configured();
  o.receive(
    identities[1]!.profileId,
    { type: "response", requestId: "opaque", error: { _tag: "Busy", holder: "other-profile" } },
    "main",
  );
  expect(o.snapshot().profiles[1]?.busyWhileForeignHeld).toBe(false);
});
it("also detects foreign orchestration identities without retaining message content", () => {
  const o = configured();
  o.push(1, "orchestration.domainEvent", {
    payload: { threadId: identities[0]!.threadId, text: "PRIVATE_MESSAGE" },
  });
  expect(o.snapshot().profiles[1]?.foreignIdentity).toBe(true);
  expect(JSON.stringify(o.snapshot())).not.toContain("PRIVATE");
});
it("fails closed on unknown origins, malformed packets and bounded observation overflow", () => {
  for (const input of ["unknown", "malformed", "overflow"]) {
    const o = configured();
    if (input === "unknown") o.receive("unexpected", { type: "heartbeat" }, "main");
    else if (input === "malformed")
      o.receive(identities[0]!.profileId, { type: "response" }, "main");
    else for (let n = 0; n <= 4096; n++) o.push(0, "computer.activity", activity(0));
    expect(o.snapshot().traceComplete).toBe(false);
  }
  const o = configured();
  expect(() => o.configure(identities)).toThrow();
});
