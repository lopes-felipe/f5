import { MspError, ProtocolError } from "@muse-code/sdk";
import type { InitializeResult } from "@muse-code/sdk/dist/src/msp.js";
import { describe, expect, it } from "vitest";

import {
  classifyMspDelivery,
  MspLocalError,
  MspRequestGate,
  openMspHost,
  PinnableCommandIdMint,
  verifyMusePermissionState,
} from "./MspSessionRuntime.ts";
import { MspTransportClosedError } from "./MspTransport.ts";
import { MockMspHost } from "./testing/mockMspHost.ts";

const mspError = (kind: string, code = -32000) =>
  new MspError({ code, message: kind, data: { kind } });

describe("classifyMspDelivery", () => {
  it.each([
    ["transport closed before the write", new MspTransportClosedError(), "not_sent", true],
    ["local in-flight cap", new MspLocalError("overloaded", "turn/start", "cap"), "not_sent", true],
    ["closed connection", new ProtocolError("connection is closed"), "not_sent", true],
    ["host overloaded", mspError("overloaded", -32001), "not_sent", true],
    ["host backpressured", mspError("backpressured", -32031), "not_sent", true],
    ["command rejected", mspError("commandRejected", -32030), "not_sent", false],
    ["invalid params", mspError("invalidParams", -32602), "not_sent", false],
    ["input too large", mspError("inputTooLarge"), "not_sent", false],
    ["timeout after write", new MspLocalError("timeout", "turn/start", "late"), "ambiguous", false],
    ["EOF after write", new ProtocolError("connection reached EOF"), "ambiguous", false],
    ["server answer", mspError("internal", -32603), "delivered", false],
  ] as const)("%s", (_label, error, certainty, retryable) => {
    expect(classifyMspDelivery(error)).toEqual({ certainty, retryable });
  });
});

describe("MspRequestGate", () => {
  it("fails the request over the cap locally without sending it", async () => {
    const gate = new MspRequestGate(2);
    let sent = 0;
    const never = () => {
      sent += 1;
      return new Promise<never>(() => undefined);
    };
    void gate.run("a", 60_000, never);
    void gate.run("b", 60_000, never);
    await expect(gate.run("c", 60_000, never)).rejects.toMatchObject({ kind: "overloaded" });
    expect(sent).toBe(2);
    expect(gate.inFlight).toBe(2);
  });

  it("times out but holds its slot until the host answers", async () => {
    const gate = new MspRequestGate(1);
    let answer: (value: string) => void = () => undefined;
    await expect(
      gate.run("slow", 10, () => new Promise<string>((resolve) => (answer = resolve))),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(gate.inFlight).toBe(1);
    await expect(gate.run("blocked", 1_000, async () => "ok")).rejects.toMatchObject({
      kind: "overloaded",
    });
    answer("late");
    await Promise.resolve();
    expect(gate.inFlight).toBe(0);
    await expect(gate.run("fast", 1_000, async () => "ok")).resolves.toBe("ok");
  });
});

describe("PinnableCommandIdMint", () => {
  it("hands out a pinned id exactly once", () => {
    const mint = new PinnableCommandIdMint();
    mint.pin("native-1");
    expect(mint.next()).toBe("native-1");
    const fresh = mint.next();
    expect(fresh).not.toBe("native-1");
    expect(fresh).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("verifyMusePermissionState", () => {
  const init = (sandboxAvailability: string) =>
    ({ sandboxAvailability }) as unknown as InitializeResult;

  it("accepts the expected approval mode with the sandbox on", () => {
    expect(
      verifyMusePermissionState({
        runtimeMode: "auto-accept-edits",
        initializeResult: init("available"),
        effectiveApprovalMode: "promptUnmatched",
      }),
    ).toEqual({ ok: true });
    expect(
      verifyMusePermissionState({
        runtimeMode: "full-access",
        initializeResult: init("available"),
        effectiveApprovalMode: "allowAll",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a different mode or an unavailable sandbox", () => {
    expect(
      verifyMusePermissionState({
        runtimeMode: "auto-accept-edits",
        initializeResult: init("available"),
        effectiveApprovalMode: "allowAll",
      }).ok,
    ).toBe(false);
    expect(
      verifyMusePermissionState({
        runtimeMode: "full-access",
        initializeResult: init("unavailable"),
        effectiveApprovalMode: "allowAll",
      }).ok,
    ).toBe(false);
  });
});

describe("openMspHost", () => {
  it("reads durability and accepts the pinned fingerprint", async () => {
    const mock = new MockMspHost({ sessionDurability: "ephemeral" });
    const host = await openMspHost({ transport: mock.transport, clientVersion: "1.0.0" });
    expect(host.fingerprintWarning).toBeUndefined();
    expect(host.durability).toEqual({ kind: "ephemeral" });
    expect(mock.requestsFor("initialize")[0]?.params).toMatchObject({
      clientInfo: { name: "F5", version: "1.0.0" },
    });
    await host.close();
  });

  it("warns, without failing, on a fingerprint mismatch", async () => {
    const mock = new MockMspHost({ fingerprint: "sha256:different" });
    const host = await openMspHost({ transport: mock.transport, clientVersion: "1.0.0" });
    expect(host.fingerprintWarning?.kind).toBe("schemaFingerprintMismatch");
    await host.close();
  });
});
