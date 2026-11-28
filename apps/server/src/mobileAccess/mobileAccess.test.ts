import { generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { get } from "node:http";
import { ORCHESTRATION_WS_METHODS, OrchestrationCommand, WS_METHODS } from "@t3tools/contracts";
import { MOBILE_CLOSE, MobileShell, type MobilePairingCode } from "@t3tools/contracts/mobile/v1";
import { derivePendingApprovals } from "@t3tools/shared/pendingApprovals";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  connectAndAwaitWelcome,
  createWsServerTestHarness,
  sendRequest,
} from "../wsServer.testHarness.ts";
import { createServer } from "../wsServer.ts";
import { pendingApprovalActivities } from "../orchestration/pendingApprovals.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { signApnsToken } from "./apnsClient.ts";
import { makeMobileAuth } from "./mobileAuth.ts";

const threadId = "mobile-fixture-thread";
const requestId = "mobile-fixture-approval";
const address = process.env.F5_MOBILE_FIXTURE_ADDRESS ?? "127.0.0.1";
const identityFile = process.env.F5_MOBILE_FIXTURE_INFO;
const mainToken = "desktop-only-fixture-token";

function port(
  server: Awaited<ReturnType<ReturnType<typeof createWsServerTestHarness>["createTestServer"]>>,
) {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Expected a TCP server");
  return addr.port;
}

function readFrame(ws: WebSocket, accepts: (frame: Record<string, unknown>) => boolean) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", listener);
      reject(new Error("Timed out waiting for mobile frame"));
    }, 5000);
    function listener(raw: Buffer) {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!accepts(frame)) return;
      clearTimeout(timer);
      ws.off("message", listener);
      resolve(frame);
    }
    ws.on("message", listener);
  });
}

describe("Phone access", () => {
  const h = createWsServerTestHarness();

  async function fixture(largeTranscript = false) {
    let engine: OrchestrationEngineShape | undefined;
    const cwd = h.makeTempDir("f5-phone-project-");
    h.server = await h.createTestServer({
      cwd,
      authToken: mainToken,
      createServerFactory: () =>
        createServer({
          detectMobileInterface: async () => ({ address, detection: "cli" }),
          onOrchestrationReady: (value) => {
            engine = value;
          },
        }),
    });
    const mainPort = port(h.server);
    const [desktop] = await connectAndAwaitWelcome(mainPort, mainToken);
    h.connections.push(desktop);
    const createdAt = new Date().toISOString();
    const projectId = "mobile-fixture-project";
    for (const command of [
      {
        type: "project.create",
        projectId,
        title: "Phone access fixture",
        workspaceRoot: cwd,
        defaultModel: "gpt-5-codex",
      },
      {
        type: "thread.create",
        projectId,
        threadId,
        title: "Review test change",
        model: "gpt-5-codex",
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      },
      {
        type: "thread.activity.append",
        threadId,
        activity: {
          id: "mobile-approval-activity",
          turnId: null,
          createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary: "Allow fixture command?",
          payload: {
            requestId,
            requestKind: "command",
            detail: "Fixture command",
            presentation: {
              defaultToNo: true,
              description: "Review the command",
              decisionReason: "Confirmation required",
            },
          },
        },
      },
      {
        type: "thread.activity.append",
        threadId,
        activity: {
          id: "mobile-input-activity",
          turnId: null,
          createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: "Answer fixture question",
          payload: {
            requestId: "mobile-fixture-question",
            blocking: false,
            questions: [{ id: "target", header: "Target", question: "Which target?", options: [] }],
          },
        },
      },
    ]) {
      await expect.poll(() => !!engine).toBe(true);
      const parsed = Schema.decodeUnknownSync(OrchestrationCommand)({
        ...command,
        commandId: "mobile-command-" + (command.activity?.id ?? command.type),
        createdAt,
      });
      await Effect.runPromise(engine!.dispatch(parsed));
    }
    if (largeTranscript) {
      for (let index = 0; index < 20; index++) {
        await Effect.runPromise(
          engine!.dispatch(
            Schema.decodeUnknownSync(OrchestrationCommand)({
              type: "thread.message.assistant.delta",
              commandId: "large-mobile-delta-" + index,
              threadId,
              messageId: "large-mobile-message",
              delta: "x".repeat(64 * 1024),
              createdAt,
            }),
          ),
        );
      }
    }
    const enabled = await sendRequest(desktop, WS_METHODS.mobileAccessSetEnabled, {
      enabled: true,
    });
    expect(enabled.result).toMatchObject({ state: "listening", address });
    const code = await sendRequest(desktop, WS_METHODS.mobileAccessCreatePairingCode, {});
    expect(code.error).toBeUndefined();
    const pairing = code.result as MobilePairingCode;
    const origin = new URL(pairing.url).searchParams.get("o")!;
    return { desktop, mainPort, pairing, origin, engine: engine! };
  }

  it("pairs and resolves a pre-existing decision over the isolated mobile listener", async () => {
    const { desktop, mainPort, pairing, origin, engine } = await fixture(true);
    async function expectPendingApprovalIds(ids: readonly string[]) {
      const model = await Effect.runPromise(engine.getReadModel());
      const thread = model.threads.find((entry) => entry.id === threadId);
      expect(thread).toBeDefined();
      const serverIds = pendingApprovalActivities(thread!).map(
        ({ payload }) => (payload as { requestId: string }).requestId,
      );
      // The web session logic re-exports this shared derivation.
      expect(
        derivePendingApprovals(thread!.activities).map((approval) => approval.requestId),
      ).toEqual(serverIds);
      expect(serverIds).toEqual(ids);
    }
    await expectPendingApprovalIds([requestId]);
    const request = (path: string, init?: RequestInit) => fetch(origin + path, init);
    expect((await request("/")).status).toBe(404);
    expect((await request("/api/assets")).status).toBe(404);
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      get(origin + "/mobile/v1/status", { headers: { Host: "wrong.invalid" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject);
    });
    expect(wrongHost).toBe(403);
    expect(
      (
        await request("/mobile/v1/bootstrap?token=" + mainToken, {
          headers: { Cookie: "token=" + mainToken },
        })
      ).status,
    ).toBe(401);
    expect(
      (await request("/mobile/v1/bootstrap", { headers: { Authorization: "Bearer " + mainToken } }))
        .status,
    ).toBe(401);

    const exchange = (code = pairing.code) =>
      request("/mobile/v1/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          deviceName: "iPhone test",
          platform: "ios",
          appVersion: "0.1.0",
          bundleId: "io.github.lopesfelipe.f5.mobile",
        }),
      });
    const results = await Promise.all([exchange(), exchange()]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 401]);
    const pair = (await results.find((response) => response.ok)!.json()) as {
      deviceId: string;
      deviceToken: string;
      serverId: string;
    };
    const headers = { Authorization: "Bearer " + pair.deviceToken };
    expect(
      (
        await fetch("http://127.0.0.1:" + mainPort + "/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: pair.deviceToken }),
        })
      ).ok,
    ).toBe(false);
    const bootstrap = (await (await request("/mobile/v1/bootstrap", { headers })).json()) as {
      backendIncarnation: string;
    };
    expect((await request("/mobile/v1/shell?incarnation=old", { headers })).status).toBe(409);
    const shellUrl = "/mobile/v1/shell?incarnation=" + bootstrap.backendIncarnation;
    const response = await request(shellUrl, { headers });
    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    const read = Schema.decodeUnknownSync(MobileShell);
    expect(
      read(await response.json()).threads.find((thread) => thread.id === threadId)?.attention,
    ).toMatchObject({
      pendingApprovalRequestIds: [requestId],
      pendingInputRequestIds: ["mobile-fixture-question"],
    });
    expect(JSON.stringify(read(await (await request(shellUrl, { headers })).json()))).not.toContain(
      "workspaceRoot",
    );

    const endpoint = origin.replace("http", "ws") + "/mobile/v1/socket?mobileApi=";
    for (const invalid of [0, 2]) {
      const socket = new WebSocket(endpoint + invalid, { headers });
      expect((await once(socket, "close"))[0]).toBe(MOBILE_CLOSE.upgradeRequired);
    }
    const socket = new WebSocket(endpoint + 1, { headers });
    h.connections.push(socket);
    expect(
      (await readFrame(socket, (frame) => frame.channel === "mobile.welcome")).body,
    ).toMatchObject({ serverId: pair.serverId });
    let id = 0;
    function rpc(method: string, body: object, peer = socket) {
      const key = String(++id);
      const reply = readFrame(peer, (frame) => frame.id === key);
      peer.send(JSON.stringify({ id: key, method, body }));
      return reply;
    }
    expect(await rpc("orchestration.dispatchCommand", {})).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(await rpc("subscribe", { selectedThreadId: threadId })).toMatchObject({
      ok: true,
      body: { snapshotRequired: true },
    });
    const tail = await rpc("getThreadTail", { threadId, messageLimit: 50, additiveField: true });
    expect(tail).toMatchObject({
      ok: true,
      body: {
        approvals: [
          {
            requestId,
            decisions: ["decline", "accept", "cancel"],
            defaultToNo: true,
            description: "Review the command",
            decisionReason: "Confirmation required",
          },
        ],
        messages: [
          { messageId: "large-mobile-message", text: expect.stringContaining("Open on the host") },
        ],
      },
    });
    expect(Buffer.byteLength(JSON.stringify(tail))).toBeLessThan(1024 * 1024);
    const registration = {
      pushToken: "a".repeat(64),
      bundleId: "io.github.lopesfelipe.f5.mobile",
      environment: "production",
    };
    expect(await rpc("registerPush", registration)).toMatchObject({ ok: true });
    const secondCode = (await sendRequest(desktop, WS_METHODS.mobileAccessCreatePairingCode, {}))
      .result as MobilePairingCode;
    const otherDevice = (await (await exchange(secondCode.code)).json()) as typeof pair;
    const otherHeaders = { Authorization: "Bearer " + otherDevice.deviceToken };
    const otherSocket = new WebSocket(endpoint + 1, { headers: otherHeaders });
    h.connections.push(otherSocket);
    await readFrame(otherSocket, (frame) => frame.channel === "mobile.welcome");
    expect(await rpc("registerPush", registration, otherSocket)).toMatchObject({ ok: true });
    expect((await sendRequest(desktop, WS_METHODS.mobileAccessListDevices, {})).result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deviceId: pair.deviceId, pushRegistered: false }),
        expect.objectContaining({ deviceId: otherDevice.deviceId, pushRegistered: true }),
      ]),
    );
    expect(await rpc("unregisterPush", {}, otherSocket)).toMatchObject({ ok: true });
    expect((await sendRequest(desktop, WS_METHODS.mobileAccessListDevices, {})).result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: otherDevice.deviceId,
          pushRegistered: false,
        }),
      ]),
    );
    const upload = await request("/mobile/v1/attachments/uploads?threadId=" + threadId, {
      method: "POST",
      headers: { ...headers, "X-F5-File-Name": "fixture.txt", "Content-Type": "text/plain" },
      body: "phone attachment",
    });
    expect(upload.status).toBe(201);
    const { uploadId } = (await upload.json()) as { uploadId: string };
    const preview = "/mobile/v1/attachments/uploads/" + uploadId;
    expect((await request(preview, { headers, method: "HEAD" })).status).toBe(200);
    expect((await request(preview, { headers: otherHeaders })).status).toBe(404);
    expect((await request("/mobile/v1/attachments/.uploads/" + uploadId, { headers })).status).toBe(
      404,
    );
    const race = await Promise.all([
      rpc("respondToApproval", { threadId, requestId, decision: "accept" }),
      rpc("respondToApproval", { threadId, requestId, decision: "accept" }),
    ]);
    expect(race.filter((result) => result.ok)).toHaveLength(1);
    expect(race.find((result) => !result.ok)).toMatchObject({ error: { code: "stale-action" } });
    const next = read(await (await request(shellUrl, { headers })).json());
    expect(
      next.threads.find((thread) => thread.id === threadId)?.attention.pendingApprovalRequestIds,
    ).toEqual([]);
    await expectPendingApprovalIds([]);
    const disabled = once(socket, "close");
    await sendRequest(desktop, WS_METHODS.mobileAccessSetEnabled, { enabled: false });
    expect((await disabled)[0]).toBe(MOBILE_CLOSE.disabled);
    expect(
      (await sendRequest(desktop, WS_METHODS.mobileAccessSetEnabled, { enabled: true })).result,
    ).toMatchObject({ state: "listening", port: Number(new URL(origin).port) });
    expect((await request(shellUrl, { headers })).status).toBe(200);
    const secondSocket = new WebSocket(endpoint + 1, { headers });
    h.connections.push(secondSocket);
    await readFrame(secondSocket, (frame) => frame.channel === "mobile.welcome");
    const revoked = once(secondSocket, "close");
    await sendRequest(desktop, WS_METHODS.mobileAccessRevokeDevice, { deviceId: pair.deviceId });
    expect((await revoked)[0]).toBe(MOBILE_CLOSE.revoked);
    expect((await request(shellUrl, { headers })).status).toBe(401);
  }, 30_000);

  it.skipIf(!identityFile)(
    "serves a paired approval fixture for the iOS simulator",
    async () => {
      const { pairing, desktop, origin } = await fixture();
      await writeFile(identityFile!, JSON.stringify({ origin, code: pairing.code }), {
        mode: 0o600,
      });
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const result = await sendRequest(desktop, ORCHESTRATION_WS_METHODS.getStartupSnapshot, {});
        const serialized = JSON.stringify(result.result ?? "");
        // The mobile client acknowledges by persisting the response, after which
        // the projected request no longer contributes to the shell.
        if (serialized.includes(threadId)) {
          const devices = await sendRequest(desktop, WS_METHODS.mobileAccessListDevices, {});
          if (Array.isArray(devices.result) && devices.result.length) {
            const tail = await sendRequest(desktop, ORCHESTRATION_WS_METHODS.getThreadTailDetails, {
              threadId,
            });
            if (JSON.stringify(tail.result ?? "").includes("approval.response-submitted")) return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("No approval response arrived from the simulator.");
    },
    150_000,
  );
});

it("expires pairing codes, evicts the oldest, and limits sources independently", () => {
  let time = 0;
  const auth = makeMobileAuth(new Map(), () => time);
  const codes = Array.from({ length: 6 }, () => auth.createCode().code);
  expect(auth.consumeCode(codes[0]!)).toBe(false);
  expect(auth.consumeCode(codes[1]!)).toBe(true);
  expect(auth.consumeCode(codes[1]!)).toBe(false);
  for (let count = 0; count < 5; count++) auth.recordFailure("one");
  expect(auth.retryAfter("one")).toBe(60);
  expect(auth.retryAfter("two")).toBe(0);
  time += 5 * 60_000;
  expect(auth.retryAfter("one")).toBe(0);
  expect(auth.consumeCode(codes[5]!)).toBe(false);
});

it("signs APNs JWTs in IEEE P1363 form", () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const [header, body, signature] = signApnsToken(keys.privateKey, "team", "key", 10_000).split(
    ".",
  );
  expect(JSON.parse(Buffer.from(body!, "base64url").toString())).toEqual({ iss: "team", iat: 10 });
  expect(
    verify(
      "sha256",
      Buffer.from(header + "." + body),
      { key: keys.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature!, "base64url"),
    ),
  ).toBe(true);
});
