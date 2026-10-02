import { AccountUsageReadError } from "./accountUsageErrors.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Effect } from "effect";
import type {
  ProviderKind,
  ProviderUsageWindow,
  ProviderInstanceId,
  AccountUsageSection,
} from "@t3tools/contracts";
import { makeAccountUsageCapability, emptyAccountSection } from "./Layers/AccountUsageService.ts";
import { asRecord, asNonNegativeNumber, asTrimmedString } from "./accountUsageJson.ts";

function resetDate(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) && Math.abs(time) < 8.64e15 ? new Date(time).toISOString() : null;
}
export function normalizeProviderLimits(
  provider: ProviderKind,
  value: unknown,
): ReadonlyArray<ProviderUsageWindow> {
  const body = asRecord(value);
  if (!body) return [];
  if (provider === "cursor") {
    const usage = asRecord(body.planUsage);
    return [
      ["totalPercentUsed", "Monthly"],
      ["autoPercentUsed", "Monthly · Auto"],
      ["apiPercentUsed", "Monthly · API"],
    ].flatMap(([id, label]) => {
      const percent = asNonNegativeNumber(usage?.[id!]);
      return percent === null
        ? []
        : [
            {
              id: id!,
              label: label!,
              usedPercent: Math.min(100, percent),
              resetsAt: resetDate(
                typeof body.billingCycleEnd === "string" && /^\d+$/.test(body.billingCycleEnd)
                  ? Number(body.billingCycleEnd)
                  : body.billingCycleEnd,
              ),
            },
          ];
    });
  }
  if (provider === "grok") {
    const config = asRecord(body.config);
    const percent = asNonNegativeNumber(config?.creditUsagePercent);
    return percent === null
      ? []
      : [
          {
            id: "subscription",
            label: "Subscription",
            usedPercent: Math.min(100, percent),
            resetsAt: resetDate(asRecord(config?.currentPeriod)?.end),
          },
        ];
  }
  if (provider === "opencode") {
    const usage = asRecord(body.usage);
    return ["rolling", "weekly", "monthly"].flatMap((id) => {
      const window = asRecord(usage?.[id]);
      const percent = asNonNegativeNumber(window?.percent);
      return percent === null
        ? []
        : [
            {
              id,
              label: `Go · ${id === "rolling" ? "Session" : id}`,
              usedPercent: Math.min(100, percent),
              resetsAt: resetDate(window?.resetsAt),
            },
          ];
    });
  }
  if (provider === "antigravity" && asRecord(body.models)) {
    return Object.entries(asRecord(body.models)!).flatMap(([id, value]) => {
      const model = asRecord(value);
      const quota = asRecord(model?.quotaInfo);
      const remaining = asNonNegativeNumber(quota?.remainingFraction);
      return remaining === null
        ? []
        : [
            {
              id,
              label: asTrimmedString(model?.displayName) ?? id,
              usedPercent: Math.max(0, Math.min(100, (1 - remaining) * 100)),
              resetsAt: resetDate(quota?.resetTime),
            },
          ];
    });
  }
  // Explicit CLIProxyAPI hub responses: do not discover hubs or read another account's credentials.
  return (Array.isArray(body.windows) ? body.windows : []).flatMap((value) => {
    const window = asRecord(value);
    const id = asTrimmedString(window?.id);
    const percent = asNonNegativeNumber(window?.usedPercent);
    return id && percent !== null
      ? [
          {
            id,
            label: asTrimmedString(window?.label) ?? id,
            usedPercent: Math.min(100, percent),
            resetsAt: resetDate(window?.resetsAt),
          },
        ]
      : [];
  });
}
async function jsonFile(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
async function fetchJson(url: string, token: string, signal: AbortSignal, body?: unknown) {
  const response = await fetch(url, {
    signal,
    redirect: "error",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body
        ? {
            "Content-Type": "application/json",
            "connect-protocol-version": "1",
            "x-cursor-client-type": "cli",
          }
        : {}),
    },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error("Usage endpoint is unavailable.");
  const maxBytes = 1024 * 1024;
  if (Number(response.headers.get("content-length")) > maxBytes || !response.body)
    throw new Error("Usage response exceeds its limit.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error("Usage response exceeds its limit.");
      chunks.push(next.value);
    }
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(combined)) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
/** A configured hub selects an exact auth-file ID; email and display name never route accounts. */
async function readAntigravityHub(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<unknown> {
  const endpoint = env.F5_CLIPROXY_HUB_URL;
  const key = env.F5_CLIPROXY_API_KEY;
  const accountId = env.F5_CLIPROXY_ACCOUNT_ID;
  if (!endpoint || !key || !accountId) return {};
  const hub = new URL(endpoint);
  if (
    hub.protocol !== "https:" &&
    !(hub.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(hub.hostname))
  )
    throw new Error("Invalid hub URL.");
  const files = asRecord(
    await fetchJson(new URL("/v0/management/auth-files", hub).toString(), key, signal),
  );
  const account = (Array.isArray(files?.files) ? files.files : [])
    .map(asRecord)
    .find(
      (file) => file?.id === accountId && file.provider === "antigravity" && file.disabled !== true,
    );
  const authIndex = asTrimmedString(account?.auth_index);
  if (!authIndex) return {};
  const response = asRecord(
    await fetchJson(new URL("/v0/management/api-call", hub).toString(), key, signal, {
      auth_index: authIndex,
      method: "POST",
      url: "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
      header: { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json" },
      data: JSON.stringify(
        env.F5_ANTIGRAVITY_PROJECT ? { project: env.F5_ANTIGRAVITY_PROJECT } : {},
      ),
    }),
  );
  if (
    typeof response?.status_code !== "number" ||
    response.status_code < 200 ||
    response.status_code >= 300 ||
    typeof response.body !== "string"
  )
    throw new Error("Hub quota request failed.");
  return JSON.parse(response.body) as unknown;
}

export function makeProviderLimits(input: {
  provider: ProviderKind;
  instanceId: ProviderInstanceId;
  displayName: string;
  enabled: boolean;
  environment: NodeJS.ProcessEnv;
  serverUrl?: string;
  apiEndpoint?: string;
}) {
  const read = Effect.tryPromise({
    try: async (signal): Promise<ReadonlyArray<AccountUsageSection>> => {
      const env = input.environment;
      const home = env.HOME || env.USERPROFILE || os.homedir();
      let value: unknown;
      if (input.provider === "cursor") {
        if (env.CURSOR_API_KEY && !env.CURSOR_AUTH_TOKEN)
          return [
            {
              ...emptyAccountSection("provider-limits"),
              outcome: "unavailable",
              errorCode: "unsupported",
              lastAttemptAt: new Date().toISOString(),
            },
          ];
        if (
          !env.CURSOR_AUTH_TOKEN &&
          (env.AGENT_CLI_CREDENTIAL_STORE === "memory" ||
            (process.platform === "darwin" && env.AGENT_CLI_CREDENTIAL_STORE !== "file"))
        )
          return [
            {
              ...emptyAccountSection("provider-limits"),
              outcome: "unavailable",
              errorCode: "unsupported",
              lastAttemptAt: new Date().toISOString(),
            },
          ];
        const dir =
          process.platform === "win32"
            ? path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Cursor")
            : process.platform === "darwin"
              ? path.join(home, ".cursor")
              : path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "cursor");
        const token =
          env.CURSOR_AUTH_TOKEN ||
          asTrimmedString(asRecord(await jsonFile(path.join(dir, "auth.json")))?.accessToken);
        if (!token)
          return [
            {
              ...emptyAccountSection("provider-limits"),
              outcome: "unavailable",
              errorCode: "unsupported",
              lastAttemptAt: new Date().toISOString(),
            },
          ];
        value = await fetchJson(
          `${(input.apiEndpoint || env.CURSOR_API_ENDPOINT || "https://api2.cursor.sh").replace(/\/$/, "")}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`,
          token,
          signal,
          {},
        );
      } else if (input.provider === "grok") {
        if (
          [
            "XAI_API_KEY",
            "GROK_OIDC_ISSUER",
            "GROK_OIDC_CLIENT_ID",
            "GROK_OAUTH2_ISSUER",
            "GROK_OAUTH2_CLIENT_ID",
            "GROK_OAUTH2_PRINCIPAL_TYPE",
            "GROK_OAUTH2_PRINCIPAL_ID",
            "GROK_AUTH_PROVIDER_COMMAND",
            "GROK_LOCAL_AUTH",
            "GROK_CLI_CHAT_PROXY_BASE_URL",
            "GROK_MODELS_BASE_URL",
            "GROK_CONFIG",
            "GROK_CONFIG_PATH",
          ].some((key) => env[key]?.trim())
        )
          return [
            {
              ...emptyAccountSection("provider-limits"),
              outcome: "unavailable",
              errorCode: "unsupported",
              lastAttemptAt: new Date().toISOString(),
            },
          ];
        const grokHome = env.GROK_HOME || path.join(home, ".grok");
        for (const name of [
          path.join(grokHome, "config.toml"),
          path.join(grokHome, "managed_config.toml"),
          path.join(grokHome, "requirements.toml"),
          "/etc/grok/managed_config.toml",
          "/etc/grok/requirements.toml",
        ]) {
          let config = "";
          try {
            config = await readFile(name, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (
            /^\s*(?:\[\[?\s*)?["']?(?:auth|grok_com_config|endpoints)["']?\s*[.\]=]/m.test(config)
          )
            return [
              {
                ...emptyAccountSection("provider-limits"),
                outcome: "unavailable",
                errorCode: "unsupported",
                lastAttemptAt: new Date().toISOString(),
              },
            ];
        }
        const auth = asRecord(
          env.GROK_AUTH
            ? JSON.parse(env.GROK_AUTH)
            : await jsonFile(path.join(grokHome, "auth.json")),
        );
        const credential = asRecord(
          auth?.["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"] ??
            auth?.["https://accounts.x.ai/sign-in"],
        );
        const token = credential?.auth_mode === "api_key" ? null : asTrimmedString(credential?.key);
        if (!token)
          return [
            {
              ...emptyAccountSection("provider-limits"),
              outcome: "unavailable",
              errorCode: "unsupported",
              lastAttemptAt: new Date().toISOString(),
            },
          ];
        value = await fetchJson(
          "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
          token,
          signal,
        );
      } else if (input.provider === "opencode") {
        if (input.serverUrl?.trim())
          return [
            {
              ...emptyAccountSection("provider-limits"),
              outcome: "unavailable",
              errorCode: "unsupported",
              lastAttemptAt: new Date().toISOString(),
            },
          ];
        const auth = asRecord(
          env.OPENCODE_AUTH_CONTENT
            ? JSON.parse(env.OPENCODE_AUTH_CONTENT)
            : await jsonFile(
                path.join(
                  env.XDG_DATA_HOME || path.join(home, ".local", "share"),
                  "opencode",
                  "auth.json",
                ),
              ),
        );
        const credential = asRecord(auth?.["opencode-go"]);
        const token =
          (credential?.type === "api" ? asTrimmedString(credential.key) : null) ||
          env.OPENCODE_API_KEY;
        if (!token)
          return [
            {
              ...emptyAccountSection("provider-limits"),
              outcome: "unavailable",
              errorCode: "unsupported",
              lastAttemptAt: new Date().toISOString(),
            },
          ];
        value = await fetchJson("https://opencode.ai/zen/go/v1/usage", token, signal);
      } else if (env.F5_CLIPROXY_HUB_URL) {
        value = await readAntigravityHub(env, signal);
      } else {
        const endpoint = env.F5_CLIPROXY_USAGE_URL;
        const token = env.F5_CLIPROXY_API_KEY;
        if (!endpoint || !token)
          return [
            {
              ...emptyAccountSection("provider-limits"),
              outcome: "unavailable",
              errorCode: "unsupported",
              lastAttemptAt: new Date().toISOString(),
            },
          ];
        const url = new URL(endpoint);
        if (
          url.protocol !== "https:" &&
          !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        )
          throw new Error("Invalid usage hub URL.");
        value = await fetchJson(url.toString(), token, signal);
      }
      const windows = normalizeProviderLimits(input.provider, value);
      const fetchedAt = new Date().toISOString();
      return [
        {
          kind: "provider-limits",
          outcome: windows.length ? "available" : "unsupported",
          errorCode: windows.length ? null : "unsupported",
          lastAttemptAt: fetchedAt,
          snapshot: { fetchedAt, data: { windows } },
        },
      ];
    },
    catch: () => new AccountUsageReadError("temporary-failure"),
  });
  return makeAccountUsageCapability(
    {
      key: `${input.provider}:${input.instanceId}`,
      provider: input.provider,
      providerInstanceId: input.instanceId,
      displayName: input.displayName,
      enabled: input.enabled,
      refreshState: "idle",
      sections: [emptyAccountSection("provider-limits")],
    },
    read,
  );
}
