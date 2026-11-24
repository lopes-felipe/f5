import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexControlClient } from "../codex/CodexControlClient.ts";
import { trustCodexHooks, trustCodexHooksWithClient } from "./codexHookTrust.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const LISTED = [
  {
    cwd: "/repo",
    hooks: [
      { key: "modified", trustStatus: "modified", currentHash: "decl-new/content-new" },
      { key: "untrusted", trustStatus: "untrusted", currentHash: "decl-u/content-u" },
      { key: "trusted", trustStatus: "trusted", currentHash: "decl-t/content-t" },
      { key: "managed", trustStatus: "managed", currentHash: "decl-m/content-m", isManaged: true },
      // A hook managed by policy is never approved, whatever status it reports.
      { key: "policy", trustStatus: "modified", currentHash: "x", isManaged: true },
      { key: "no-hash", trustStatus: "modified" },
    ],
  },
];

function fakeClient(listed: ReadonlyArray<Record<string, unknown>> = LISTED) {
  return {
    listHooks: vi.fn(async (_cwds: ReadonlyArray<string>) => listed),
    batchWriteConfig: vi.fn(async (_input: unknown) => ({ version: "v2" })),
  };
}

describe("trustCodexHooksWithClient", () => {
  it("trusts only modified or untrusted hooks with the freshly listed hash, in one write", async () => {
    const client = fakeClient();
    const result = await trustCodexHooksWithClient(client as never, {
      projectRoot: "/repo",
      keys: ["modified", "untrusted", "trusted", "managed", "policy", "no-hash", "unknown"],
    });
    expect(result).toEqual({
      trusted: ["modified", "untrusted"],
      skipped: ["trusted", "managed", "policy", "no-hash", "unknown"],
    });
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

  it("does not write when nothing needs approval and dedupes requested keys", async () => {
    const client = fakeClient();
    const result = await trustCodexHooksWithClient(client as never, {
      keys: ["trusted", "trusted"],
    });
    expect(result).toEqual({ trusted: [], skipped: ["trusted"] });
    expect(client.listHooks).toHaveBeenCalledWith([]);
    expect(client.batchWriteConfig).not.toHaveBeenCalled();
  });

  it("passes Codex's write error through unchanged", async () => {
    const client = fakeClient();
    const message =
      "Invalid configuration: features.chronicle=true is not allowed by requirements (allowed: false)";
    client.batchWriteConfig.mockRejectedValueOnce(new Error(message));
    await expect(
      trustCodexHooksWithClient(client as never, { keys: ["modified"] }),
    ).rejects.toThrow(message);
  });
});

describe("trustCodexHooks", () => {
  it("opens the control client in the project and always closes it", async () => {
    const client = { ...fakeClient(), closeAndWait: vi.fn(async () => {}) };
    client.batchWriteConfig.mockRejectedValueOnce(new Error("write failed"));
    const create = vi
      .spyOn(CodexControlClient, "create")
      .mockResolvedValue(client as unknown as CodexControlClient);
    await expect(
      trustCodexHooks({ cwd: "/home" }, { projectRoot: "/repo", keys: ["modified"] }),
    ).rejects.toThrow("write failed");
    expect(create.mock.calls[0]?.[0]).toMatchObject({ cwd: "/repo" });
    expect(client.closeAndWait).toHaveBeenCalledOnce();
  });
});
