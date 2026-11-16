import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "vitest";
import { AcpSessionRuntime } from "./AcpSessionRuntime";
import { parsePermissionRequest, type AcpPermissionRequest } from "./AcpRuntimeModel";
import { writeAcpWrapper } from "../../testUtils/cli";

it.each([false, true])(
  "isolates ID-only approvals and colliding updates by session (hardening: %s)",
  async (enabled) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "f5-acp-permission-"));
    try {
      const executable = writeAcpWrapper(
        path.join(cwd, "agent"),
        path.resolve("scripts/acp-mock-agent.ts"),
        {
          env: { ACP_MOCK_ID_ONLY_PERMISSION: "1" },
        },
      );
      const approvals: AcpPermissionRequest[] = [];
      await Effect.runPromise(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            AcpSessionRuntime.layer({
              spawn: { command: executable, args: [], cwd },
              cwd,
              clientInfo: { name: "test", version: "1" },
              authMethodId: "test",
              hardening: { enabled, provider: "custom-acp" },
            }),
          );
          const runtime = yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(context));
          yield* runtime.handleRequestPermission((request) =>
            Effect.gen(function* () {
              expect((yield* runtime.getPromptActivity!).paused).toBe(true);
              approvals.push(parsePermissionRequest(request));
              return { outcome: { outcome: "selected" as const, optionId: "allow" } };
            }),
          );
          yield* runtime.start();
          yield* runtime.prompt({ prompt: [{ type: "text", text: "Check status" }] });
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
      expect(approvals).toHaveLength(4);
      expect(approvals[0]).toMatchObject({ kind: "unknown" });
      expect(approvals[1]).toMatchObject({ kind: "unknown" });
      expect(approvals[2]).toMatchObject({ kind: "unknown" });
      expect(approvals[3]).toMatchObject({ kind: "execute", detail: "git status" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  20_000,
);
