/**
 * Approve Codex hooks whose contents changed (or were never reviewed) through
 * Codex's own API, the same `hooks.state` write its `/hooks` screen makes.
 *
 * The caller names hooks by key only. Each hash is read from a fresh
 * `hooks/list` in the same control session, so trust always applies to what
 * Codex reports at the moment of the write, never to a browser-supplied value.
 * Managed and already trusted hooks are skipped.
 *
 * @module provider/codexHookTrust
 */
import type { ServerTrustProviderHooksResult } from "@t3tools/contracts";

import {
  CodexControlClient,
  type CodexControlEnvironmentConfig,
} from "../codex/CodexControlClient.ts";
import { codexHookTrustStatus } from "./codexInventory.ts";

export const CODEX_HOOK_TRUST_TIMEOUT_MS = 20_000;

type HookTrustClient = Pick<CodexControlClient, "listHooks" | "batchWriteConfig">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Current hash of every hook that needs approval, keyed by hook key. */
function approvableHashes(entries: ReadonlyArray<unknown>): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of entries) {
    const hooks = isRecord(entry) && Array.isArray(entry.hooks) ? entry.hooks : [];
    for (const hook of hooks) {
      if (!isRecord(hook) || typeof hook.key !== "string" || hook.isManaged === true) continue;
      const status = codexHookTrustStatus(hook.trustStatus);
      if (status !== "modified" && status !== "untrusted") continue;
      if (typeof hook.currentHash !== "string" || hook.currentHash.length === 0) continue;
      result.set(hook.key, hook.currentHash);
    }
  }
  return result;
}

export async function trustCodexHooksWithClient(
  client: HookTrustClient,
  input: { readonly projectRoot?: string | undefined; readonly keys: ReadonlyArray<string> },
): Promise<ServerTrustProviderHooksResult> {
  const listed = await client.listHooks(input.projectRoot ? [input.projectRoot] : []);
  const hashes = approvableHashes(listed);
  const trusted: string[] = [];
  const skipped: string[] = [];
  const state: Record<string, { trusted_hash: string }> = {};
  for (const key of new Set(input.keys)) {
    const hash = hashes.get(key);
    if (hash === undefined) {
      skipped.push(key);
      continue;
    }
    trusted.push(key);
    state[key] = { trusted_hash: hash };
  }
  if (trusted.length > 0) {
    // Codex splits a `declaration/content` hash into trusted_hash and
    // trusted_content_hash itself. Write errors (e.g. requirements validation)
    // propagate unchanged so the user sees Codex's own explanation.
    await client.batchWriteConfig({
      edits: [{ keyPath: "hooks.state", value: state, mergeStrategy: "upsert" }],
      reloadUserConfig: true,
    });
  }
  return { trusted, skipped };
}

/** Opens a control client for the instance, trusts the hooks, and always closes it. */
export async function trustCodexHooks(
  environment: CodexControlEnvironmentConfig,
  input: { readonly projectRoot?: string | undefined; readonly keys: ReadonlyArray<string> },
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
      const fail = () => reject(new Error("Approving Codex hooks timed out."));
      if (signal.aborted) fail();
      signal.addEventListener("abort", fail, { once: true });
    });
    return await Promise.race([trustCodexHooksWithClient(client, input), aborted]);
  } finally {
    await client?.closeAndWait();
  }
}
