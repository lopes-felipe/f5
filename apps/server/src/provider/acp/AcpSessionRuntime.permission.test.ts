import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "vitest";
import { AcpSessionRuntime } from "./AcpSessionRuntime";
import { parsePermissionRequest, type AcpPermissionRequest } from "./AcpRuntimeModel";
import { writeAcpWrapper } from "../../testUtils/cli";

it("enriches same-session ID-only approvals on the wire and passes through startup and foreign requests", async () => {
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
          }),
        );
        const runtime = yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(context));
        yield* runtime.handleRequestPermission((request) =>
          Effect.sync(() => {
            approvals.push(parsePermissionRequest(request));
            return { outcome: { outcome: "selected" as const, optionId: "allow" } };
          }),
        );
        yield* runtime.start();
        yield* runtime.prompt({ prompt: [{ type: "text", text: "Check status" }] });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
    expect(approvals).toHaveLength(3);
    expect(approvals[0]).toMatchObject({ kind: "unknown" });
    expect(approvals[1]).toMatchObject({ kind: "unknown" });
    expect(approvals[2]).toMatchObject({ kind: "execute", detail: "git status" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 20_000);
