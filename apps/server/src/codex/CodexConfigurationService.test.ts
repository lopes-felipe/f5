import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexControlClient } from "./CodexControlClient";
import { CodexConfigurationService } from "./CodexConfigurationService";

const provider = {
  id: "team",
  name: "Team",
  canEdit: true,
  baseUrl: null,
  settings: { type: "customGateway", auth: { mode: "externallyConfigured", envKey: null } },
};
function setup() {
  const client = Object.assign(new EventEmitter(), {
    cliVersion: "0.170.0",
    close: vi.fn(),
    closeAndWait: vi.fn(async () => undefined),
    readConfig: vi.fn(async () => ({
      config: { desktop: { f5_audio_attachments: false }, features: {} },
    })),
    batchWriteConfig: vi.fn(async () => ({})),
    configurationRequest: vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
      if (method === "modelProvider/list")
        return { data: [provider], defaultProviderId: "team", canChangeDefault: true };
      if (method === "account/gatewayOAuth/read")
        return {
          providerId: "team",
          providerName: "Team",
          required: true,
          supportsDeviceAuth: true,
          status: "notReady",
          error: null,
        };
      if (method === "account/securitySetup/read") return { notice: null };
      if (method === "account/gatewayOAuth/login")
        return {
          prompt: {
            loginId: "login-1",
            verificationUrl: "https://example.test/login",
            userCode: "CODE",
          },
        };
      return {};
    }),
  });
  vi.spyOn(CodexControlClient, "create").mockResolvedValue(client as unknown as CodexControlClient);
  const service = new CodexConfigurationService({ cwd: "/tmp" });
  return { client, service };
}
afterEach(() => vi.restoreAllMocks());

describe("Codex native configuration", () => {
  it("uses only edited patch fields and preserves unexposed authentication", async () => {
    const { service, client } = setup();
    try {
      await service.execute({
        type: "write",
        settings: { type: "customGateway", providerId: "team", name: "Renamed" },
      });
      expect(client.configurationRequest).toHaveBeenCalledWith("modelProvider/config/write", {
        settings: { type: "customGateway", providerId: "team", name: "Renamed" },
      });
    } finally {
      await service.close();
    }
  });
  it("rejects read-only writes and defaults before dispatch", async () => {
    const { service, client } = setup();
    client.configurationRequest.mockImplementation(async (method) => {
      if (method === "modelProvider/list")
        return {
          data: [{ ...provider, canEdit: false }],
          defaultProviderId: "team",
          canChangeDefault: false,
        };
      return {};
    });
    try {
      await expect(
        service.execute({
          type: "write",
          settings: { type: "customGateway", providerId: "team", name: "x" },
        }),
      ).rejects.toThrow("read-only");
      await expect(service.execute({ type: "setDefault", providerId: "team" })).rejects.toThrow(
        "cannot be selected",
      );
      expect(client.batchWriteConfig).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });
  it("ignores another login's completion and rejects cancellation of stale prompts", async () => {
    const { service, client } = setup();
    try {
      await service.execute({ type: "gatewayLogin", providerId: "team", deviceAuth: true });
      client.emit("notification", {
        method: "account/gatewayOAuth/changed",
        params: {
          providerId: "team",
          loginId: "older",
          status: "succeeded",
        },
      });
      expect(
        (await service.execute({ type: "gatewayRead", providerId: "team" })).login?.status,
      ).toBe("started");
      await expect(service.execute({ type: "gatewayCancel", loginId: "older" })).rejects.toThrow(
        "no longer active",
      );
      await service.execute({ type: "gatewayCancel", loginId: "login-1" });
      client.emit("notification", {
        method: "account/gatewayOAuth/changed",
        params: {
          providerId: "team",
          loginId: "login-1",
          status: "succeeded",
        },
      });
      expect(
        (await service.execute({ type: "gatewayRead", providerId: "team" })).login,
      ).toBeUndefined();
    } finally {
      await service.close();
    }
  });
  it("retains a browser authorization handoff emitted before the response", async () => {
    const { service, client } = setup();
    const original = client.configurationRequest.getMockImplementation()!;
    client.configurationRequest.mockImplementation(async (method, params) => {
      if (method === "account/gatewayOAuth/login") {
        client.emit("notification", {
          method: "account/gatewayOAuth/changed",
          params: {
            providerId: "team",
            loginId: null,
            status: "started",
            authUrl: "https://example.test/login",
          },
        });
        return { prompt: null };
      }
      return original(method, params);
    });
    try {
      expect(
        (await service.execute({ type: "gatewayLogin", providerId: "team", deviceAuth: false }))
          .login,
      ).toMatchObject({ authUrl: "https://example.test/login", status: "started" });
    } finally {
      await service.close();
    }
  });
  it("fences a replaced instance and closes its control process", async () => {
    const { service, client } = setup();
    await service.execute({ type: "read" });
    await service.close();
    await expect(service.execute({ type: "read" })).rejects.toThrow("replaced");
    expect(client.closeAndWait).toHaveBeenCalledOnce();
  });
});
