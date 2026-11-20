import {
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationSession,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { mapSessionFromReadModel, mapMessageAttachmentsFromReadModel } from "./orchestrationState";

it("retains attachment provenance across hydration and invalidates changed sources", () => {
  const image = {
    type: "image" as const,
    id: "snapshot",
    name: "snapshot.png",
    mimeType: "image/png",
    sizeBytes: 128,
  };
  const first = mapMessageAttachmentsFromReadModel([image], undefined)!;
  const next = mapMessageAttachmentsFromReadModel([{ ...image, source: "snapshot" }], first)!;
  expect(next[0]?.source).toBe("snapshot");
  expect(next).not.toBe(first);
  expect(mapMessageAttachmentsFromReadModel([{ ...image, source: "snapshot" }], next)).toBe(next);
});

const session: OrchestrationSession = {
  threadId: ThreadId.makeUnsafe("limited"),
  status: "ready",
  providerName: "claudeAgent",
  providerInstanceId: ProviderInstanceId.makeUnsafe("claude"),
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: "Usage limit reached",
  lastErrorId: "failure",
  lastErrorOccurredAt: "2026-10-07T12:00:00.000Z",
  lastErrorRetryability: null,
  updatedAt: "2026-10-07T12:00:00.000Z",
  usageLimit: {
    windows: [{ id: "five_hour", label: "5-hour", resetsAt: "2026-10-07T15:00:00.000Z" }],
    resetsAt: "2026-10-07T15:00:00.000Z",
    resetSource: "provider",
    evidence: "typed",
    providerInstanceId: ProviderInstanceId.makeUnsafe("claude"),
    turnId: TurnId.makeUnsafe("failed-turn"),
    deliveryId: null,
  },
};
describe("usage limit session mapping", () => {
  it("keeps extension status across a turn failure but clears it on provider or instance replacement", () => {
    const source = {
      ...session,
      providerName: "pi",
      extensionStatuses: [{ key: "test", text: "Ready" }],
    };
    const mapped = mapSessionFromReadModel(source, null);
    const { extensionStatuses: _removed, ...next } = source;
    expect(
      mapSessionFromReadModel({ ...next, status: "error" }, mapped)?.extensionStatuses,
    ).toEqual(source.extensionStatuses);
    expect(
      mapSessionFromReadModel({ ...next, providerName: "codex" }, mapped)?.extensionStatuses,
    ).toEqual([]);
    expect(
      mapSessionFromReadModel(
        { ...next, providerInstanceId: ProviderInstanceId.make("another") },
        mapped,
      )?.extensionStatuses,
    ).toEqual([]);
  });
  it("preserves the structured limit and reuses an equal session", () => {
    const mapped = mapSessionFromReadModel(session, null);
    expect(mapped?.usageLimit).toEqual(session.usageLimit);
    expect(
      mapSessionFromReadModel(
        { ...session, usageLimit: structuredClone(session.usageLimit) },
        mapped,
      ),
    ).toBe(mapped);
  });
  it("updates when only the reset changes and clears an unstated limit", () => {
    const mapped = mapSessionFromReadModel(session, null);
    const changed = mapSessionFromReadModel(
      { ...session, usageLimit: { ...session.usageLimit!, resetsAt: "2026-10-07T16:00:00.000Z" } },
      mapped,
    );
    expect(changed).not.toBe(mapped);
    expect(changed?.usageLimit?.resetsAt).toBe("2026-10-07T16:00:00.000Z");
    expect(
      mapSessionFromReadModel({ ...session, usageLimit: undefined }, changed)?.usageLimit,
    ).toBeNull();
  });
});
