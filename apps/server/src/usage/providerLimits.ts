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
import { accountUsageIdentity } from "./accountUsage.ts";
import { asRecord, asNonNegativeNumber, asTrimmedString, resetDate } from "./accountUsageJson.ts";
import { mergeProviderUsageWindows } from "./providerUsageWindows.ts";

// The capability has an eight-second deadline; leave one second to publish collected quotas.
const ANTIGRAVITY_READ_BUDGET_MS = 7_000;
const ANTIGRAVITY_DISCOVERY_TIMEOUT_MS = 6_000;
const ANTIGRAVITY_QUOTA_TIMEOUT_MS = 3_000;
// Gemini requires this upstream client version: https://github.com/pingdotgg/t3code/commit/79f1fadfc6020b820d541ca4691d2feebb15dd1b
const ANTIGRAVITY_USER_AGENT = `antigravity/hub/2.24.0 (aidev_client; os_type=${process.platform}; arch=${process.arch}; cl=963137146)`;

function antigravitySummaryWindows(
  body: Record<string, unknown>,
  requestedAt: number,
): ReadonlyArray<ProviderUsageWindow> {
  const groups = Array.isArray(body.groups) ? body.groups.map(asRecord) : [];
  const buckets = groups.some((group) => Array.isArray(group?.buckets) && group.buckets.length)
    ? groups.flatMap((group) =>
        (Array.isArray(group?.buckets) ? group.buckets : []).map((bucket) => ({
          bucket: asRecord(bucket),
          groupName: asTrimmedString(group?.displayName),
        })),
      )
    : (Array.isArray(body.buckets) ? body.buckets : []).map((bucket) => ({
        bucket: asRecord(bucket),
        groupName: null,
      }));
  return mergeProviderUsageWindows([
    buckets.flatMap(({ bucket, groupName }) => {
      const id = asTrimmedString(bucket?.bucketId);
      const remaining = bucket?.remainingFraction;
      if (
        !id ||
        typeof remaining !== "number" ||
        !Number.isFinite(remaining) ||
        bucket?.disabled === true
      )
        return [];
      const family = id.startsWith("gemini-argon-")
        ? (groupName ?? "Gemini Argon")
        : id.startsWith("gemini-")
          ? "Gemini"
          : id.startsWith("3p-")
            ? "Claude & GPT (shared)"
            : (groupName ?? id);
      const durationMs =
        bucket?.window === "weekly"
          ? 7 * 24 * 60 * 60_000
          : bucket?.window === "5h"
            ? 5 * 60 * 60_000
            : null;
      const reset = resetDate(bucket?.resetTime);
      // Untouched buckets can report a reset that merely rolls forward with the request.
      const untouched =
        remaining === 1 &&
        bucket?.description === undefined &&
        durationMs !== null &&
        reset !== null &&
        Math.abs(Date.parse(reset) - requestedAt - durationMs) <= 60_000;
      const label =
        bucket?.window === "weekly"
          ? "Weekly"
          : bucket?.window === "5h"
            ? "5-hour"
            : (asTrimmedString(bucket?.displayName) ?? "Quota");
      return [
        {
          id,
          label: `${family} · ${label}`,
          usedPercent: Math.max(0, Math.min(100, (1 - remaining) * 100)),
          resetsAt: untouched ? null : reset,
        },
      ];
    }),
  ]);
}

export function normalizeProviderLimits(
  provider: ProviderKind,
  value: unknown,
  requestedAt = Date.now(),
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
    // xAI leaves the percentage out, rather than sending 0, until usage registers. Reading
    // that as unsupported told a freshly signed-in account its CLI could not report limits.
    const percent =
      config && config.creditUsagePercent === undefined
        ? 0
        : asNonNegativeNumber(config?.creditUsagePercent);
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
  if (provider === "antigravity" && (Array.isArray(body.groups) || Array.isArray(body.buckets))) {
    return antigravitySummaryWindows(body, requestedAt);
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
  const endpoint = new URL(url);
  if (
    endpoint.protocol !== "https:" &&
    !(
      endpoint.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
    )
  )
    throw new Error("Invalid credential endpoint URL.");
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
async function fetchJsonWithTimeout(
  url: string,
  token: string,
  signal: AbortSignal,
  timeoutMs: number,
  body?: unknown,
) {
  signal.throwIfAborted();
  if (timeoutMs <= 0) throw new AccountUsageReadError("timeout");
  const controller = new AbortController();
  const requestSignal = AbortSignal.any([signal, controller.signal]);
  const cancelled = Promise.withResolvers<never>();
  const onAbort = () => cancelled.reject(requestSignal.reason);
  requestSignal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new AccountUsageReadError("timeout")), timeoutMs);
  try {
    // Bound the promise too, so a transport that ignores abort cannot hold the read open.
    return await Promise.race([fetchJson(url, token, requestSignal, body), cancelled.promise]);
  } finally {
    clearTimeout(timer);
    requestSignal.removeEventListener("abort", onAbort);
  }
}

/** A configured hub selects an exact auth-file ID; email and display name never route accounts. */
async function readAntigravityHub(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<{ readonly windows: ReadonlyArray<ProviderUsageWindow>; readonly partial: boolean }> {
  const deadline = performance.now() + ANTIGRAVITY_READ_BUDGET_MS;
  const remainingMs = () => Math.max(0, deadline - performance.now());
  const endpoint = env.F5_CLIPROXY_HUB_URL;
  const key = env.F5_CLIPROXY_API_KEY;
  const accountId = env.F5_CLIPROXY_ACCOUNT_ID;
  if (!endpoint || !key || !accountId) return { windows: [], partial: false };
  const hub = new URL(endpoint);
  if (
    hub.protocol !== "https:" &&
    !(hub.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(hub.hostname))
  )
    throw new Error("Invalid hub URL.");
  const files = asRecord(
    await fetchJsonWithTimeout(
      new URL("/v0/management/auth-files", hub).toString(),
      key,
      signal,
      Math.min(ANTIGRAVITY_DISCOVERY_TIMEOUT_MS, remainingMs()),
    ),
  );
  const account = (Array.isArray(files?.files) ? files.files : [])
    .map(asRecord)
    .find(
      (file) => file?.id === accountId && file.provider === "antigravity" && file.disabled !== true,
    );
  const authIndex = asTrimmedString(account?.auth_index);
  if (!authIndex) return { windows: [], partial: false };
  const fetchWindows = async (host: string, operation: string, timeoutMs: number) => {
    try {
      const requestedAt = Date.now();
      const response = asRecord(
        await fetchJsonWithTimeout(
          new URL("/v0/management/api-call", hub).toString(),
          key,
          signal,
          timeoutMs,
          {
            auth_index: authIndex,
            method: "POST",
            url: `https://${host}/v1internal:${operation}`,
            header: {
              Authorization: "Bearer $TOKEN$",
              "Content-Type": "application/json",
              "User-Agent": ANTIGRAVITY_USER_AGENT,
            },
            data: JSON.stringify(
              env.F5_ANTIGRAVITY_PROJECT ? { project: env.F5_ANTIGRAVITY_PROJECT } : {},
            ),
          },
        ),
      );
      if (
        typeof response?.status_code !== "number" ||
        response.status_code < 200 ||
        response.status_code >= 300 ||
        typeof response.body !== "string"
      )
        throw new Error("Hub quota request failed.");
      return {
        windows: normalizeProviderLimits("antigravity", JSON.parse(response.body), requestedAt),
        failed: false,
      };
    } catch {
      signal.throwIfAborted();
      return { windows: [], failed: true };
    }
  };
  const responses = await Promise.all(
    ["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"].map(async (host) => {
      // Each host owns its fallback; another host's shared buckets cannot suppress Gemini.
      const summary = await fetchWindows(
        host,
        "retrieveUserQuotaSummary",
        Math.min(ANTIGRAVITY_QUOTA_TIMEOUT_MS, remainingMs() / 2),
      );
      if (summary.windows.length) return summary;
      const models = await fetchWindows(
        host,
        "fetchAvailableModels",
        Math.min(ANTIGRAVITY_QUOTA_TIMEOUT_MS, remainingMs()),
      );
      return { windows: models.windows, failed: summary.failed || models.failed };
    }),
  );
  signal.throwIfAborted();
  const windows = mergeProviderUsageWindows(responses.map((response) => response.windows));
  if (!windows.length && responses.some((response) => response.failed))
    throw new AccountUsageReadError("temporary-failure");
  return {
    windows,
    partial:
      windows.length > 0 &&
      responses.some((response) => response.failed || !response.windows.length),
  };
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
      let partial = false;
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
        const result = await readAntigravityHub(env, signal);
        value = { windows: result.windows };
        partial = result.partial;
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
          outcome: partial ? "unavailable" : windows.length ? "available" : "unsupported",
          errorCode: partial ? "temporary-failure" : windows.length ? null : "unsupported",
          lastAttemptAt: fetchedAt,
          snapshot: { fetchedAt, data: { windows } },
        },
      ];
    },
    catch: (error) =>
      error instanceof AccountUsageReadError
        ? error
        : new AccountUsageReadError("temporary-failure"),
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
    {
      identity: providerLimitsIdentity(input),
      retryFailedReads:
        input.provider === "antigravity" && Boolean(input.environment.F5_CLIPROXY_HUB_URL),
    },
  );
}

/** Environment variables that `read` uses to select an account or endpoint. */
const IDENTITY_ENV_KEYS = [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "APPDATA",
  "OPENCODE_API_KEY",
  "CURSOR_AUTH_TOKEN",
  "CURSOR_API_KEY",
  "CURSOR_API_ENDPOINT",
  "AGENT_CLI_CREDENTIAL_STORE",
  "GROK_AUTH",
  "GROK_HOME",
  "XAI_API_KEY",
] as const;

/** The OpenCode Go credential `read` selects, ignoring other providers' tokens in the blob. */
function opencodeGoCredential(content: string | undefined): string | null {
  if (!content) return null;
  try {
    const credential = asRecord(asRecord(JSON.parse(content))?.["opencode-go"]);
    return credential?.type === "api" ? (asTrimmedString(credential.key) ?? null) : null;
  } catch {
    return "invalid";
  }
}

/**
 * Persisted-history identity from the inputs the reader uses to pick an
 * account. Where a stable account identifier exists it stands in for the
 * secret (the CLIProxy account ID, not the hub management key; the selected
 * OpenCode Go key, not refreshable tokens elsewhere in the auth blob).
 * Otherwise the credential itself is an input: a rotated API key cannot be
 * told apart from a different account, so it starts new history rather than
 * risk mixing two accounts. The recorder stores only a keyed HMAC of this.
 */
export function providerLimitsIdentity(input: {
  readonly provider: ProviderKind;
  readonly environment: NodeJS.ProcessEnv;
  readonly serverUrl?: string;
  readonly apiEndpoint?: string;
}): string {
  const env = input.environment;
  return accountUsageIdentity(input.provider, [
    env.HOME || env.USERPROFILE || os.homedir(),
    input.serverUrl,
    input.apiEndpoint,
    `OPENCODE_AUTH_CONTENT=${opencodeGoCredential(env.OPENCODE_AUTH_CONTENT) ?? ""}`,
    ...IDENTITY_ENV_KEYS.map((key) => `${key}=${env[key] ?? ""}`),
    ...Object.keys(env)
      .filter(
        (key) =>
          (key.startsWith("F5_CLIPROXY_") && key !== "F5_CLIPROXY_API_KEY") ||
          key === "F5_ANTIGRAVITY_PROJECT" ||
          (key.startsWith("GROK_") && key !== "GROK_AUTH" && key !== "GROK_HOME"),
      )
      .sort()
      .map((key) => `${key}=${env[key] ?? ""}`),
  ]);
}
