import { CodexConfigurationResult, type CodexConfigurationAction } from "@t3tools/contracts";
import { supportsCodexRelease6 } from "@t3tools/shared/providerRuntimeCapabilities";
import { Schema } from "effect";
import { randomUUID } from "node:crypto";
import { CodexControlClient, type CodexControlEnvironmentConfig } from "./CodexControlClient";
import {
  buildCodexGatewayLoginParams,
  buildCodexGatewayReadParams,
  buildCodexProviderWriteParams,
} from "./codexConfigurationRequests";

const decode = Schema.decodeUnknownSync(CodexConfigurationResult);
type Login = NonNullable<CodexConfigurationResult["login"]>;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** One bounded control connection per instance. Login notifications stay on their initiating connection. */
export class CodexConfigurationService {
  private client: CodexControlClient | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private login: Login | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private pending = 0;
  constructor(private readonly environment: CodexControlEnvironmentConfig) {}

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    const client = this.client;
    this.client = undefined;
    this.login = undefined;
    await client?.closeAndWait();
  }

  execute(action: CodexConfigurationAction): Promise<CodexConfigurationResult> {
    if (this.pending >= 16)
      return Promise.reject(new Error("Codex configuration is busy. Try again shortly."));
    this.pending++;
    clearTimeout(this.timer);
    const next = this.chain.then(() => this.run(action));
    this.chain = next.catch(() => undefined);
    return next.finally(() => {
      this.pending--;
      if (this.pending !== 0 || !this.client) return;
      const client = this.client;
      this.timer = setTimeout(
        () => {
          if (this.client !== client) return;
          client.close();
          this.client = undefined;
          this.login = undefined;
        },
        this.login?.status === "started" ? 10 * 60_000 : 30_000,
      );
      this.timer.unref?.();
    });
  }

  private async connect(): Promise<CodexControlClient> {
    if (this.closed) throw new Error("This Codex provider was replaced.");
    if (!this.client) {
      const client = await CodexControlClient.create(
        { ...this.environment, explicitGatewayOauth: true },
        undefined,
        { probeConfigRead: true },
      );
      if (this.closed) {
        client.close();
        throw new Error("This Codex provider was replaced.");
      }
      if (!supportsCodexRelease6(client.cliVersion)) {
        client.close();
        throw new Error("Codex model provider settings require Codex 0.170.0 or later.");
      }
      this.client = client;
      client.on("notification", ({ method, params }) => {
        if (this.client !== client) return;
        if (method === "account/updated") this.login = undefined;
        if (method !== "account/gatewayOAuth/changed") return;
        const data = record(params);
        if (!this.login || data.providerId !== this.login.providerId) return;
        if (data.loginId != null && data.loginId !== this.login.loginId) return;
        this.login = {
          ...this.login,
          status: typeof data.status === "string" ? data.status : this.login.status,
          authUrl: typeof data.authUrl === "string" ? data.authUrl : this.login.authUrl,
          error: typeof data.error === "string" ? data.error : null,
        };
      });
      client.on("closed", () => {
        if (this.client !== client) return;
        this.client = undefined;
        this.login = undefined;
      });
      // Explicit gateway OAuth requires a readiness read on every connection.
      try {
        await client.configurationRequest("account/gatewayOAuth/read");
      } catch (error) {
        client.close();
        this.client = undefined;
        throw error;
      }
    }
    return this.client;
  }

  private async run(action: CodexConfigurationAction): Promise<CodexConfigurationResult> {
    const client = await this.connect();
    const securityNotice = async () =>
      record(
        await client
          .configurationRequest("account/securitySetup/read", {}, 2_000)
          .catch(() => ({ notice: null })),
      ).notice ?? null;
    if (action.type === "securityRead") return decode({ securityNotice: await securityNotice() });
    const request = (method: string, params?: unknown) =>
      client.configurationRequest(method, params);
    if (action.type === "gatewayCancel") {
      if (!this.login || action.loginId !== this.login.loginId)
        throw new Error("This gateway login is no longer active.");
      try {
        await request("account/gatewayOAuth/cancel");
      } finally {
        this.client = undefined;
        this.login = undefined;
        // Browser authorization events have no native loginId. Retiring the
        // initiating connection fences late events from a subsequent attempt.
        await client.closeAndWait();
      }
      return {};
    }
    if (action.type === "gatewayRead" || action.type === "gatewayLogin") {
      const gateway = record(
        await request("account/gatewayOAuth/read", buildCodexGatewayReadParams(action.providerId)),
      );
      if (this.login?.providerId === action.providerId && gateway.status === "succeeded")
        this.login = { ...this.login, status: "succeeded" };
      if (action.type === "gatewayLogin") {
        if (this.login?.status === "started")
          throw new Error("Cancel the current gateway login first.");
        if (action.deviceAuth && gateway.supportsDeviceAuth !== true)
          throw new Error("This gateway does not support device authorization.");
        this.login = {
          loginId: randomUUID(),
          providerId: action.providerId,
          status: "started",
          authUrl: null,
          verificationUrl: null,
          userCode: null,
          error: null,
        };
        // Subscribe before dispatch, including notifications delivered before the response.
        const early: Record<string, unknown>[] = [];
        const observe = ({ method, params }: { method: string; params?: unknown }) => {
          if (method === "account/gatewayOAuth/changed" && early.length < 16)
            early.push(record(params));
        };
        client.on("notification", observe);
        try {
          const response = record(
            await request(
              "account/gatewayOAuth/login",
              buildCodexGatewayLoginParams(action.providerId, action.deviceAuth),
            ),
          );
          if (!this.login || this.client !== client)
            throw new Error(
              "The Codex account changed during gateway sign-in. Check its sign-in status.",
            );
          const prompt = record(response.prompt);
          const event = early.findLast(
            (entry) =>
              entry.providerId === action.providerId &&
              (prompt.loginId == null || entry.loginId === prompt.loginId),
          );
          const loginId = prompt.loginId ?? event?.loginId ?? this.login.loginId;
          this.login =
            typeof loginId === "string"
              ? {
                  loginId,
                  providerId: action.providerId,
                  status: typeof event?.status === "string" ? event.status : this.login.status,
                  authUrl: typeof event?.authUrl === "string" ? event.authUrl : this.login.authUrl,
                  verificationUrl:
                    typeof prompt.verificationUrl === "string" ? prompt.verificationUrl : null,
                  userCode: typeof prompt.userCode === "string" ? prompt.userCode : null,
                  error: typeof event?.error === "string" ? event.error : null,
                }
              : undefined;
          const readiness = record(
            await request(
              "account/gatewayOAuth/read",
              buildCodexGatewayReadParams(action.providerId),
            ),
          );
          if (this.login && readiness.status === "succeeded")
            this.login = { ...this.login, status: "succeeded" };
        } catch (error) {
          this.client = undefined;
          this.login = undefined;
          await client.closeAndWait();
          throw error;
        } finally {
          client.off("notification", observe);
        }
      }
      return decode({
        gateway,
        ...(this.login?.providerId === action.providerId ? { login: this.login } : {}),
      });
    }
    const providers = decode({ providers: await request("modelProvider/list") }).providers!;
    if (action.type === "write") {
      const id = action.settings.providerId;
      const existing = providers.data.find((provider) => provider.id === id);
      if (id && (existing ? !existing.canEdit : action.settings.type === "customGateway"))
        throw new Error("This model provider is read-only.");
      await request("modelProvider/config/write", buildCodexProviderWriteParams(action.settings));
    }
    if (action.type === "setDefault") {
      if (
        !providers.canChangeDefault ||
        !providers.data.some((provider) => provider.id === action.providerId)
      )
        throw new Error("This default provider cannot be selected.");
      await client.batchWriteConfig({
        edits: [{ keyPath: "model_provider", value: action.providerId, mergeStrategy: "replace" }],
        reloadUserConfig: true,
      });
    }
    if (action.type === "setFeature") {
      await client.batchWriteConfig({
        edits: [
          {
            keyPath:
              action.feature === "animation"
                ? "features.image_generation_animation"
                : "desktop.f5_audio_attachments",
            value: action.enabled,
            mergeStrategy: "replace",
          },
        ],
        reloadUserConfig: true,
      });
    }
    const config = (await client.readConfig(false)).config;
    return decode({
      providers: action.type === "read" ? providers : await request("modelProvider/list"),
      features: {
        audio: record(config.desktop).f5_audio_attachments === true,
        animation: record(config.features).image_generation_animation === true,
      },
      securityNotice: await securityNotice(),
    });
  }
}
