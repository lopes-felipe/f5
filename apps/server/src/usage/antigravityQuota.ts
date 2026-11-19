import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderUsageWindow } from "@t3tools/contracts";
import { asRecord, asTrimmedString } from "./accountUsageJson.ts";
import { mergeProviderUsageWindows } from "./providerUsageWindows.ts";

const HOSTS = ["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"];

/** Uses only this ACP account's credentials; refreshed access tokens stay in memory. */
export function makeAntigravityQuotaReader(input: {
  profileDirectory: string;
  normalize: (response: unknown, requestedAt: number) => ReadonlyArray<ProviderUsageWindow>;
  fetch?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
  readFile?: (file: string) => Promise<string>;
  now?: () => number;
}) {
  const request = input.fetch ?? fetch;
  const read = input.readFile ?? ((file: string) => readFile(file, "utf8"));
  const now = input.now ?? Date.now;
  let cached: { fingerprint: string; accessToken: string; expiresAt: number } | undefined;

  return async (signal: AbortSignal, deadline = performance.now() + 7_000) => {
    const remainingMs = () => Math.max(0, deadline - performance.now());
    let text: string;
    try {
      text = await read(join(input.profileDirectory, "antigravity-acp", "acp_token.json"));
    } catch (error) {
      cached = undefined;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("Could not read Antigravity credentials.");
    }
    signal.throwIfAborted();
    const token = asRecord(JSON.parse(text));
    const clientId = asTrimmedString(token?.client_id);
    const clientSecret = asTrimmedString(token?.client_secret);
    const refreshToken = asTrimmedString(token?.refresh_token);
    const project = asTrimmedString(token?.project_id);
    if (!clientId || !clientSecret || !refreshToken) {
      cached = undefined;
      return null;
    }
    const fingerprint = createHash("sha256")
      .update([clientId, refreshToken, project ?? ""].join("\0"))
      .digest("hex");
    const json = async (url: string, init: RequestInit, maximumMs = 6_000) => {
      const timeoutMs = Math.min(maximumMs, remainingMs());
      if (timeoutMs <= 0) throw new Error("Antigravity quota deadline reached.");
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("Antigravity quota deadline reached.")),
        timeoutMs,
      );
      const requestSignal = AbortSignal.any([signal, controller.signal]);
      let onAbort = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(requestSignal.reason);
        if (requestSignal.aborted) onAbort();
        else requestSignal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([
          aborted,
          (async () => {
            const response = await request(url, {
              ...init,
              signal: requestSignal,
              redirect: "error",
            });
            if (!response.ok) {
              if (response.status === 401 || response.status === 403) cached = undefined;
              throw new Error("Antigravity quota request failed.");
            }
            return response.json() as Promise<unknown>;
          })(),
        ]);
      } finally {
        clearTimeout(timer);
        requestSignal.removeEventListener("abort", onAbort);
      }
    };
    if (cached?.fingerprint !== fingerprint || cached.expiresAt <= now() + 60_000) {
      cached = undefined;
      const refreshed = asRecord(
        await json("https://oauth2.googleapis.com/token", {
          method: "POST",
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
          }),
        }),
      );
      const accessToken = asTrimmedString(refreshed?.access_token);
      const expiresIn = refreshed?.expires_in;
      if (
        !accessToken ||
        typeof expiresIn !== "number" ||
        !Number.isFinite(expiresIn) ||
        expiresIn <= 0
      )
        throw new Error("Antigravity returned an invalid access token.");
      cached = { fingerprint, accessToken, expiresAt: now() + expiresIn * 1000 };
    }
    const accessToken = cached.accessToken;
    const responses = await Promise.all(
      HOSTS.map(async (host) => {
        let failed = false;
        for (const operation of ["retrieveUserQuotaSummary", "fetchAvailableModels"]) {
          try {
            const requestedAt = now();
            const body = await json(
              "https://" + host + "/v1internal:" + operation,
              {
                method: "POST",
                headers: {
                  Authorization: "Bearer " + accessToken,
                  "Content-Type": "application/json",
                  "User-Agent":
                    "antigravity/hub/2.24.0 (aidev_client; os_type=" +
                    process.platform +
                    "; arch=" +
                    process.arch +
                    "; cl=963137146)",
                },
                body: JSON.stringify(project ? { project } : {}),
              },
              operation === "retrieveUserQuotaSummary" ? Math.min(3_000, remainingMs() / 2) : 6_000,
            );
            const windows = input.normalize(body, requestedAt);
            if (windows.length) return { windows, failed };
          } catch {
            signal.throwIfAborted();
            failed = true;
          }
        }
        return { windows: [], failed };
      }),
    );
    signal.throwIfAborted();
    const windows = mergeProviderUsageWindows(responses.map((response) => response.windows));
    if (!windows.length && responses.some((response) => response.failed))
      throw new Error("Could not read Antigravity quotas.");
    return {
      windows,
      accountFingerprint: fingerprint,
      partial:
        windows.length > 0 &&
        responses.some((response) => response.failed || !response.windows.length),
    };
  };
}
