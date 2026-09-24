import { writeSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as AcpAgent from "../../src/agent";

if (process.env.ACP_MOCK_MALFORMED_OUTPUT === "1") {
  process.stdout.write("{not-json}\n");
  process.exit(Number(process.env.ACP_MOCK_MALFORMED_OUTPUT_EXIT_CODE ?? "0"));
}

if (process.env.ACP_MOCK_EXIT_IMMEDIATELY_CODE !== undefined) {
  if (process.env.ACP_MOCK_EXIT_STDERR) writeSync(2, process.env.ACP_MOCK_EXIT_STDERR);
  process.exit(Number(process.env.ACP_MOCK_EXIT_IMMEDIATELY_CODE));
}

const sessionId = "mock-session-1";

const program = Effect.gen(function* () {
  const agent = yield* AcpAgent.AcpAgent;

  yield* agent.handleInitialize(() =>
    Effect.succeed({
      protocolVersion: 1,
      agentCapabilities: {
        sessionCapabilities: {
          list: {},
        },
      },
      agentInfo: {
        name: "mock-agent",
        version: "0.0.0",
      },
    }),
  );

  yield* agent.handleAuthenticate(() => Effect.succeed({}));
  yield* agent.handleLogout(() => Effect.succeed({}));
  yield* agent.handleCreateSession(() =>
    Effect.succeed({
      sessionId,
    }),
  );
  yield* agent.handleLoadSession(() => Effect.succeed({}));
  yield* agent.handleListSessions(() =>
    Effect.succeed({
      sessions: [
        {
          sessionId,
          cwd: process.cwd(),
        },
      ],
    }),
  );

  yield* agent.handlePrompt(() =>
    Effect.gen(function* () {
      yield* agent.client.requestPermission({
        sessionId,
        options: [
          {
            optionId: "allow",
            name: "Allow",
            kind: "allow_once",
          },
        ],
        toolCall: {
          toolCallId: "tool-1",
          title: "Read project files",
        },
      });

      const elicitationRequest = {
        sessionId,
        message: "Need confirmation before continuing.",
        mode: "form",
        requestedSchema: {
          type: "object",
          title: "Need confirmation",
          properties: {
            approved: {
              type: "boolean",
              title: "Approved",
            },
          },
          required: ["approved"],
        },
      } as const;
      if (process.env.ACP_MOCK_ELICITATION_ALIAS === "1") {
        const response = yield* agent.raw.request("elicitation/create", elicitationRequest);
        if (
          JSON.stringify(response) !==
          JSON.stringify({ action: "accept", content: { approved: true } })
        )
          throw new Error("Unexpected SDK elicitation response");
      } else {
        yield* agent.client.elicit(elicitationRequest);
      }

      yield* agent.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "plan",
          entries: [
            {
              content: "Inspect the repository",
              priority: "high",
              status: "in_progress",
            },
          ],
        },
      });

      if (process.env.ACP_MOCK_ELICITATION_ALIAS === "1") {
        yield* agent.raw.notify("elicitation/complete", { elicitationId: "elicitation-1" });
      } else {
        yield* agent.client.elicitationComplete({ elicitationId: "elicitation-1" });
      }

      yield* agent.client.extRequest("x/typed_request", {
        message: process.env.ACP_MOCK_BAD_TYPED_REQUEST === "1" ? 123 : "hello from typed request",
      });

      yield* agent.client.extNotification("x/typed_notification", {
        count: 2,
      });

      return {
        stopReason: "end_turn" as const,
      };
    }),
  );

  yield* agent.handleUnknownExtRequest((method, params) =>
    Effect.succeed({
      echoedMethod: method,
      echoedParams: params ?? null,
    }),
  );

  return yield* Effect.never;
});

program.pipe(
  Effect.provide(Layer.provide(AcpAgent.layerStdio(), NodeServices.layer)),
  NodeRuntime.runMain,
);
