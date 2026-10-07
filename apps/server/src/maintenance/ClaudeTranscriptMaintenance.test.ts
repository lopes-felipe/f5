import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { Effect, Option } from "effect";
import { ThreadId, type ProviderSession } from "@t3tools/contracts";
import type {
  ProviderRuntimeBinding,
  ProviderRuntimeBindingWithMetadata,
} from "../provider/Services/ProviderSessionDirectory.ts";
import { withProviderThreadAccess } from "../provider/providerThreadAccess.ts";
import {
  getClaudeTranscriptMaintenance,
  runClaudeTranscriptMaintenance,
  claudeMaintenanceErrorMessage,
} from "./ClaudeTranscriptMaintenance.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "f5-maintenance-"));
  dirs.push(dir);
  const sessionId = "550e8400-e29b-41d4-a716-446655440000";
  const project = path.join(dir, "relative-store", "projects", "project");
  await mkdir(project, { recursive: true });
  const file = path.join(project, `${sessionId}.jsonl`);
  await writeFile(
    file,
    JSON.stringify({
      uuid: "root",
      parentUuid: null,
      sessionId,
      cwd: dir,
      type: "assistant",
      timestamp: "2026-10-07T09:00:00Z",
      message: { role: "assistant", content: [] },
    }) + "\n",
  );
  let binding: ProviderRuntimeBindingWithMetadata = {
    threadId: ThreadId.makeUnsafe(dir),
    provider: "claudeAgent",
    status: "starting",
    lastSeenAt: "2026-10-07T09:00:00Z",
    resumeCursor: { resume: sessionId, resumeSessionAt: "missing", missingResumePoint: "missing" },
    runtimePayload: { cwd: dir, marker: "latest" },
  };
  let live: ProviderSession | undefined;
  let failSave = false;
  const directory = {
    getBinding: () => Effect.sync(() => Option.some(binding)),
    upsert: (next: ProviderRuntimeBinding) =>
      Effect.sync(() => {
        if (failSave) {
          failSave = false;
          throw new Error("Injected persistence failure");
        }
        binding = { ...binding, ...next };
      }),
  };
  const service = {
    listSessions: () => Effect.sync(() => (live ? [live] : [])),
    stopSession: () =>
      Effect.sync(() => {
        live = undefined;
        binding = {
          ...binding,
          status: "stopped",
          runtimePayload: { cwd: dir, marker: "stopped" },
        };
      }),
  };
  const input = {
    threadId: binding.threadId,
    directory,
    service,
    resolveAccount: async () => ({ environment: { CLAUDE_CONFIG_DIR: "relative-store" } }),
    providerLogsDir: dir,
  };
  return {
    input,
    file,
    directory,
    binding: () => binding,
    failNextSave: () => {
      failSave = true;
    },
    admit: (status: "ready" | "running") => {
      live = {
        threadId: binding.threadId,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        status,
        createdAt: binding.lastSeenAt,
        updatedAt: binding.lastSeenAt,
      };
    },
  };
}

it("offers repair after a successful fallback without requiring a thread error", async () => {
  const f = await fixture();
  expect(await Effect.runPromise(getClaudeTranscriptMaintenance(f.input))).toEqual({
    canRepair: true,
  });
});
it("serializes maintenance with a session admitted after the request began and preserves stopped fields", async () => {
  const f = await fixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const admission = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const launch = Effect.runPromise(
    withProviderThreadAccess(
      f.input.threadId,
      Effect.promise(async () => {
        entered();
        await pending;
        f.admit("ready");
      }),
    ),
  );
  await admission;
  const repair = Effect.runPromise(runClaudeTranscriptMaintenance(f.input));
  release();
  await launch;
  expect((await repair)?.status).toBe("repaired");
  expect(f.binding()).toMatchObject({ status: "stopped", runtimePayload: { marker: "stopped" } });
});
it("refuses mutation if the newly admitted session has an active turn", async () => {
  const f = await fixture();
  const original = await readFile(f.file, "utf8");
  f.admit("running");
  await expect(Effect.runPromise(runClaudeTranscriptMaintenance(f.input))).rejects.toThrow(
    "Stop the active turn",
  );
  expect(await readFile(f.file, "utf8")).toBe(original);
});
it("reconciles a file commit whose cursor save failed, exposes undo, and retires stale undo after newer writes", async () => {
  const f = await fixture();
  f.failNextSave();
  await expect(Effect.runPromise(runClaudeTranscriptMaintenance(f.input))).rejects.toThrow(
    "Injected persistence failure",
  );
  const status = await Effect.runPromise(getClaudeTranscriptMaintenance(f.input));
  expect(status?.backupId).toBeDefined();
  expect(status?.canRepair).toBe(false);
  expect(f.binding().resumeCursor).toMatchObject({
    transcriptRepairBackupId: status!.backupId,
    resumeRecoveryGeneration: expect.any(String),
  });
  await writeFile(
    f.file,
    (await readFile(f.file, "utf8")) + JSON.stringify({ uuid: "new", parentUuid: null }) + "\n",
  );
  expect(await Effect.runPromise(getClaudeTranscriptMaintenance(f.input))).toEqual({
    canRepair: false,
  });
});
it("sanitizes filesystem paths in client errors", () => {
  expect(
    claudeMaintenanceErrorMessage(
      Object.assign(new Error("ENOENT /private/home/transcript"), { code: "ENOENT" }),
    ),
  ).not.toContain("/private/home");
});
