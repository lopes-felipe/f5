import { expect, it, vi } from "vitest";
import type { ComputerLeaseHolder, ComputerTargetReadiness } from "@t3tools/contracts";
import { ComputerCooperation } from "./ComputerCooperation";
import type { ComputerHelper } from "./ComputerHelperClient";

function fixture() {
  let now = 0;
  const ready: ComputerTargetReadiness = {
    activityEpoch: 0,
    lastActivityAgeMs: -1,
    frontmost: false,
    monitorHealthy: true,
    inputSequence: 0,
    lastUserInputAgeMs: -1,
    inputHeld: false,
  };
  const helper: ComputerHelper = {
    status: () => ({ available: true }),
    request: async () => ({}),
    control: vi.fn(),
    suspend: async () => {},
    onEvent: () => () => {},
    capabilities: () => ["computer-cooperation-v1"],
    watch: vi.fn(async () => ready),
    availability: vi.fn(async () => ready),
  };
  const cooperation = new ComputerCooperation(helper, () => now);
  const holder = (index = 0): ComputerLeaseHolder => ({
    profileId: "profile",
    threadId: "thread-" + index,
    sessionGeneration: "session",
    turnId: "turn",
    executionGeneration: index + 1,
    grantVersion: 1,
    grants: [],
    backend: "native",
    threadTitle: "Thread",
    scope: { kind: "app", appId: "app-" + index },
    policyRevision: 0,
  });
  return {
    helper,
    cooperation,
    holder,
    setNow: (value: number) => {
      now = value;
    },
  };
}
it("refreshes observe-only app epochs from heartbeat while no generation is armed", async () => {
  const h = fixture();
  const holder = h.holder();
  await h.cooperation.prepare(holder);
  h.cooperation.heartbeat({
    inputSequence: 2,
    inputHeld: false,
    monitorHealthy: true,
    lastUserInputAgeMs: 6000,
    targets: [
      {
        appId: "app-0",
        activityEpoch: 4,
        lastActivityAgeMs: 500,
        frontmost: false,
      },
    ],
  });
  expect(h.cooperation.readiness(holder)).toMatchObject({
    activityEpoch: 4,
    lastActivityAgeMs: 500,
    inputSequence: 2,
  });
});
it("keeps input-held foreground blocking while ignoring the diagnostic held-input list", () => {
  const h = fixture();
  const foreground = { ...h.holder(), scope: { kind: "foreground" as const } };
  const beat = (inputHeld: boolean) =>
    h.cooperation.heartbeat({
      inputSequence: 3,
      inputHeld,
      monitorHealthy: true,
      lastUserInputAgeMs: 60_000,
      heldInputs: inputHeld ? [{ kind: "modifier", code: 56 }] : [],
    });
  beat(true);
  expect(h.cooperation.blockedDetail(foreground)).toBe("input-held");
  beat(false);
  expect(h.cooperation.blockedDetail(foreground)).toBeUndefined();
  expect(h.cooperation.readiness(foreground)).not.toHaveProperty("heldInputs");
});
it("backs off repeated yielding, resets after sixty seconds, and releases a turn's native watch", async () => {
  const h = fixture();
  const holder = h.holder();
  await h.cooperation.prepare(holder);
  expect(h.cooperation.yield(holder).dwell).toBe(1500);
  h.cooperation.continued(holder);
  h.setNow(1000);
  expect(h.cooperation.yield(holder).dwell).toBe(3000);
  for (let index = 0; index < 8; index++) {
    h.setNow(2000 + index * 1000);
    h.cooperation.yield(holder);
  }
  expect(h.cooperation.yielded.get("profile\0thread-0")?.dwell).toBe(15_000);
  h.setNow(70_000);
  expect(h.cooperation.yield(holder).dwell).toBe(1500);
  h.cooperation.release((entry) => entry.threadId === holder.threadId);
  expect(h.helper.control).toHaveBeenCalledWith({
    type: "watchRelease",
    appId: "app-0",
    owner: "profile\0thread-0\0session\0turn",
  });
  expect(h.cooperation.yielded.size).toBe(0);
  expect(h.cooperation.observationSequence(holder, "app-0")).toBe(0);
});
it("rejects a thirty-third watch and reclaims capacity when a session closes", async () => {
  const h = fixture();
  for (let index = 0; index < 32; index++) await h.cooperation.prepare(h.holder(index));
  await expect(h.cooperation.prepare(h.holder(32))).rejects.toThrow("watch limit");
  h.cooperation.release((entry) => entry.threadId === "thread-0");
  await expect(h.cooperation.prepare(h.holder(32))).resolves.toBeUndefined();
  h.cooperation.reset();
});
it("rejects stale registration after helper restart without removing the new helper's watch", async () => {
  const h = fixture();
  let complete!: (value: ComputerTargetReadiness) => void;
  const ready: ComputerTargetReadiness = {
    activityEpoch: 2,
    lastActivityAgeMs: -1,
    frontmost: false,
    monitorHealthy: true,
    inputSequence: 2,
    lastUserInputAgeMs: -1,
    inputHeld: false,
  };
  vi.mocked(h.helper.watch!).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const old = h.cooperation.prepare(h.holder());
  const rejected = expect(old).rejects.toMatchObject({ error: { _tag: "Interrupted" } });
  h.cooperation.reset();
  vi.mocked(h.helper.watch!).mockResolvedValueOnce(ready);
  await h.cooperation.prepare(h.holder());
  complete({ ...ready, activityEpoch: 1 });
  await rejected;
  expect(h.cooperation.readiness(h.holder())?.activityEpoch).toBe(2);
  expect(h.helper.control).toHaveBeenCalledTimes(1);
  h.cooperation.reset();
});
