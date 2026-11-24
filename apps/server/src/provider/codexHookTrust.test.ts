import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexControlClient } from "../codex/CodexControlClient.ts";
import { trustCodexHooks, trustCodexHooksWithClient } from "./codexHookTrust.ts";
import { codexHookTrustScope, codexHookTrustToken, parseCodexHooks } from "./codexInventory.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const SCOPE = codexHookTrustScope("codex", "/repo");

type Hook = Record<string, unknown>;

const BEFORE: ReadonlyArray<Hook> = [
  { key: "modified", trustStatus: "modified", currentHash: "decl-new/content-new" },
  { key: "untrusted", trustStatus: "untrusted", currentHash: "decl-u/content-u" },
  { key: "trusted", trustStatus: "trusted", currentHash: "decl-t/content-t" },
  { key: "managed", trustStatus: "managed", currentHash: "decl-m/content-m", isManaged: true },
  // A hook managed by policy is never approved, whatever status it reports.
  { key: "policy", trustStatus: "modified", currentHash: "x", isManaged: true },
  { key: "no-hash", trustStatus: "modified" },
].map((hook) => ({ eventName: "stop", source: "plugin", ...hook }));

function trusted(hooks: ReadonlyArray<Hook>, keys: ReadonlyArray<string>): Hook[] {
  return hooks.map((hook) =>
    keys.includes(String(hook.key)) ? { ...hook, trustStatus: "trusted" } : hook,
  );
}

/** Lists `before`, then whatever each later call returns. */
function fakeClient(before: ReadonlyArray<Hook>, ...later: ReadonlyArray<ReadonlyArray<Hook>>) {
  const listings = [before, ...later];
  let call = 0;
  return {
    listHooks: vi.fn(async (_cwds: ReadonlyArray<string>) => [
      { cwd: "/repo", hooks: listings[Math.min(call++, listings.length - 1)] },
    ]),
    batchWriteConfig: vi.fn(async (_input: unknown) => ({ version: "v2" })),
  };
}

/** The tokens the inventory would have issued for `hooks`, keyed by hook key. */
function tokens(hooks: ReadonlyArray<Hook>, scope = SCOPE): Map<string, string> {
  return new Map(
    parseCodexHooks([{ hooks }], scope).flatMap((hook) =>
      hook.key && hook.trustToken ? [[hook.key, hook.trustToken] as const] : [],
    ),
  );
}

function request(keys: ReadonlyArray<string>, issued = tokens(BEFORE)) {
  return {
    projectRoot: "/repo",
    trustTokenScope: SCOPE,
    hooks: keys.map((key) => ({ key, token: issued.get(key) ?? "no-token" })),
  };
}

describe("trust tokens", () => {
  it("are issued only for approvable hooks and never expose the hash", () => {
    const parsed = parseCodexHooks([{ hooks: BEFORE }], SCOPE);
    expect(parsed.filter((hook) => hook.trustToken).map((hook) => hook.key)).toEqual([
      "modified",
      "untrusted",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("decl-");
    expect(parseCodexHooks([{ hooks: BEFORE }]).some((hook) => hook.trustToken)).toBe(false);
  });

  it("depend on scope, key and hash", () => {
    const base = codexHookTrustToken(SCOPE, "k", "h");
    expect(codexHookTrustToken(SCOPE, "k", "h")).toBe(base);
    expect(codexHookTrustToken(codexHookTrustScope("codex", undefined), "k", "h")).not.toBe(base);
    expect(codexHookTrustToken(SCOPE, "k2", "h")).not.toBe(base);
    expect(codexHookTrustToken(SCOPE, "k", "h2")).not.toBe(base);
  });
});

describe("trustCodexHooksWithClient", () => {
  it("trusts matching modified or untrusted hooks with the fresh hash in one write, then verifies", async () => {
    const client = fakeClient(BEFORE, trusted(BEFORE, ["modified", "untrusted"]));
    const result = await trustCodexHooksWithClient(
      client as never,
      request(["modified", "untrusted", "trusted", "managed", "policy", "no-hash", "unknown"]),
    );
    expect(result).toEqual({
      trusted: ["modified", "untrusted"],
      skipped: ["trusted", "managed", "policy", "no-hash", "unknown"],
      changed: [],
      failed: [],
    });
    expect(client.listHooks).toHaveBeenCalledTimes(2);
    expect(client.listHooks).toHaveBeenCalledWith(["/repo"]);
    expect(client.batchWriteConfig).toHaveBeenCalledOnce();
    expect(client.batchWriteConfig).toHaveBeenCalledWith({
      edits: [
        {
          keyPath: "hooks.state",
          value: {
            modified: { trusted_hash: "decl-new/content-new" },
            untrusted: { trusted_hash: "decl-u/content-u" },
          },
          mergeStrategy: "upsert",
        },
      ],
      reloadUserConfig: true,
    });
  });

  it("refuses a hook whose contents changed after the inventory was read", async () => {
    const issued = tokens(BEFORE);
    const updated = BEFORE.map((hook) =>
      hook.key === "modified" ? { ...hook, currentHash: "decl-newer/content-newer" } : hook,
    );
    const client = fakeClient(updated, trusted(updated, ["untrusted"]));
    const result = await trustCodexHooksWithClient(
      client as never,
      request(["modified", "untrusted"], issued),
    );
    expect(result).toEqual({
      trusted: ["untrusted"],
      skipped: [],
      changed: ["modified"],
      failed: [],
    });
    expect(client.batchWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        edits: [
          expect.objectContaining({ value: { untrusted: { trusted_hash: "decl-u/content-u" } } }),
        ],
      }),
    );
  });

  it("refuses tokens issued for another project scope", async () => {
    const client = fakeClient(BEFORE);
    const foreign = tokens(BEFORE, codexHookTrustScope("codex", "/other"));
    const result = await trustCodexHooksWithClient(client as never, request(["modified"], foreign));
    expect(result.changed).toEqual(["modified"]);
    expect(client.batchWriteConfig).not.toHaveBeenCalled();
  });

  it("reports hooks Codex still does not trust after the write as failed", async () => {
    const client = fakeClient(BEFORE, BEFORE);
    const result = await trustCodexHooksWithClient(client as never, request(["modified"]));
    expect(result).toEqual({ trusted: [], skipped: [], changed: [], failed: ["modified"] });
  });

  it("does not write when nothing needs approval and dedupes requested keys", async () => {
    const client = fakeClient(BEFORE);
    const result = await trustCodexHooksWithClient(client as never, {
      trustTokenScope: SCOPE,
      hooks: [
        { key: "trusted", token: "t" },
        { key: "trusted", token: "t" },
      ],
    });
    expect(result).toEqual({ trusted: [], skipped: ["trusted"], changed: [], failed: [] });
    expect(client.listHooks).toHaveBeenCalledOnce();
    expect(client.listHooks).toHaveBeenCalledWith([]);
    expect(client.batchWriteConfig).not.toHaveBeenCalled();
  });

  it("passes Codex's write error through unchanged", async () => {
    const client = fakeClient(BEFORE);
    const message =
      "Invalid configuration: features.chronicle=true is not allowed by requirements (allowed: false)";
    client.batchWriteConfig.mockRejectedValueOnce(new Error(message));
    await expect(trustCodexHooksWithClient(client as never, request(["modified"]))).rejects.toThrow(
      message,
    );
  });
});

describe("trustCodexHooks", () => {
  it("opens the control client in the project and always closes it", async () => {
    const client = { ...fakeClient(BEFORE), closeAndWait: vi.fn(async () => {}) };
    client.batchWriteConfig.mockRejectedValueOnce(new Error("write failed"));
    const create = vi
      .spyOn(CodexControlClient, "create")
      .mockResolvedValue(client as unknown as CodexControlClient);
    await expect(trustCodexHooks({ cwd: "/home" }, request(["modified"]))).rejects.toThrow(
      "write failed",
    );
    expect(create.mock.calls[0]?.[0]).toMatchObject({ cwd: "/repo" });
    expect(client.closeAndWait).toHaveBeenCalledOnce();
  });

  it("says the approval may have been saved when Codex does not answer in time", async () => {
    const client = {
      listHooks: vi.fn(() => new Promise<never>(() => {})),
      batchWriteConfig: vi.fn(),
      closeAndWait: vi.fn(async () => {}),
    };
    vi.spyOn(CodexControlClient, "create").mockResolvedValue(
      client as unknown as CodexControlClient,
    );
    await expect(trustCodexHooks({ cwd: "/home" }, request(["modified"]), 20)).rejects.toThrow(
      "It may still have been saved",
    );
    expect(client.closeAndWait).toHaveBeenCalledOnce();
  });
});
