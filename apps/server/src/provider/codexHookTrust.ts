/**
 * Approve Codex hooks whose contents changed (or were never reviewed) through
 * Codex's own API, the same `hooks.state` write its `/hooks` screen makes.
 *
 * The caller names each hook by key with the opaque token the inventory issued
 * for it. Hashes are re-read from a fresh `hooks/list` in the same control
 * session, and a hook is approved only while its token still matches, so trust
 * never covers contents the user was not shown. After the write, a second
 * `hooks/list` confirms Codex now reports each hook as trusted.
 *
 * Codex splits the `declaration/content` hash into `trusted_hash` and
 * `trusted_content_hash` when it persists the write (0.166+), replacing any
 * stale content hash, and an upsert keeps unrelated fields such as `enabled`.
 *
 * @module provider/codexHookTrust
 */
import type { ServerTrustProviderHooksResult } from "@t3tools/contracts";
import { timingSafeEqual } from "node:crypto";

import {
  CodexControlClient,
  type CodexControlEnvironmentConfig,
} from "../codex/CodexControlClient.ts";
import { codexHookApprovalHash, codexHookTrustToken } from "./codexInventory.ts";

export const CODEX_HOOK_TRUST_TIMEOUT_MS = 20_000;

type HookTrustClient = Pick<CodexControlClient, "listHooks" | "batchWriteConfig">;

export interface CodexHookTrustRequest {
  readonly projectRoot?: string | undefined;
  /** Scope the inventory issued the tokens with (`codexHookTrustScope`). */
  readonly trustTokenScope: string;
  readonly hooks: ReadonlyArray<{ readonly key: string; readonly token: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function listedHooks(entries: ReadonlyArray<unknown>): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const hooks = isRecord(entry) && Array.isArray(entry.hooks) ? entry.hooks : [];
    for (const hook of hooks) {
      if (isRecord(hook) && typeof hook.key === "string" && !result.has(hook.key)) {
        result.set(hook.key, hook);
      }
    }
  }
  return result;
}

function sameToken(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function trustCodexHooksWithClient(
  client: HookTrustClient,
  input: CodexHookTrustRequest,
): Promise<ServerTrustProviderHooksResult> {
  const cwds = input.projectRoot ? [input.projectRoot] : [];
  const before = listedHooks(await client.listHooks(cwds));
  const written: string[] = [];
  const skipped: string[] = [];
  const changed: string[] = [];
  const state: Record<string, { trusted_hash: string }> = {};
  const seen = new Set<string>();
  for (const { key, token } of input.hooks) {
    if (seen.has(key)) continue;
    seen.add(key);
    const hash = codexHookApprovalHash(before.get(key));
    if (hash === undefined) {
      skipped.push(key);
    } else if (!sameToken(codexHookTrustToken(input.trustTokenScope, key, hash), token)) {
      changed.push(key);
    } else {
      written.push(key);
      state[key] = { trusted_hash: hash };
    }
  }
  if (written.length === 0) return { trusted: [], skipped, changed, failed: [] };

  // Write errors (e.g. requirements validation) propagate unchanged so the
  // user sees Codex's own explanation.
  await client.batchWriteConfig({
    edits: [{ keyPath: "hooks.state", value: state, mergeStrategy: "upsert" }],
    reloadUserConfig: true,
  });
  const after = listedHooks(await client.listHooks(cwds));
  const trusted: string[] = [];
  const failed: string[] = [];
  for (const key of written) {
    const status = after.get(key)?.trustStatus;
    if (status === "trusted" || status === "managed") trusted.push(key);
    else failed.push(key);
  }
  return { trusted, skipped, changed, failed };
}

/** Opens a control client for the instance, trusts the hooks, and always closes it. */
export async function trustCodexHooks(
  environment: CodexControlEnvironmentConfig,
  input: CodexHookTrustRequest,
  timeoutMs = CODEX_HOOK_TRUST_TIMEOUT_MS,
): Promise<ServerTrustProviderHooksResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  let client: CodexControlClient | undefined;
  try {
    client = await CodexControlClient.create(
      { ...environment, cwd: input.projectRoot ?? environment.cwd },
      signal,
    );
    const aborted = new Promise<never>((_, reject) => {
      const fail = () =>
        reject(
          new Error(
            "Codex did not confirm the approval in time. It may still have been saved; reload the hooks to check.",
          ),
        );
      if (signal.aborted) fail();
      signal.addEventListener("abort", fail, { once: true });
    });
    return await Promise.race([trustCodexHooksWithClient(client, input), aborted]);
  } finally {
    await client?.closeAndWait();
  }
}
