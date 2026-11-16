import { randomUUID } from "node:crypto";
import type { ComputerAgentProvider } from "@t3tools/shared/agentAutomationSupport";
import { automationEventSanitizer } from "@t3tools/shared/automationActivitySanitizer";
import type { ComputerAutomationBrokerRuntime } from "./ComputerAutomationBroker";
import {
  callComputerTool,
  ComputerToolGeometry,
  subscribeComputerObservationInvalidation,
} from "./computerMcpTools";

/** Transport-independent ownership. Dispose only after the transport's producer stops. */
export function createComputerSessionScope(input: {
  broker: ComputerAutomationBrokerRuntime;
  threadId: string;
  serverName: string;
  provider: ComputerAgentProvider;
}) {
  const generation = `${input.provider}:${randomUUID()}`;
  input.broker.bindSession(input.threadId, generation, input.provider);
  const release = automationEventSanitizer.retain(input.threadId);
  automationEventSanitizer.register(input.threadId, {
    serverName: input.serverName,
    verified: true,
    kind: "f5-computer",
  });
  let geometry = new ComputerToolGeometry();
  let disposed = false;
  const off = subscribeComputerObservationInvalidation(
    input.broker,
    input.threadId,
    (preserveApps) => geometry.clear(preserveApps),
  );
  return {
    generation,
    get geometry() {
      return geometry;
    },
    resetConnection() {
      geometry.dispatcher.invalidate();
      geometry.clear();
      geometry = new ComputerToolGeometry();
    },
    call(name: string, args: unknown, invocationId?: string) {
      return callComputerTool(
        {
          broker: input.broker,
          threadId: input.threadId,
          sessionGeneration: generation,
          geometry,
          ...(invocationId !== undefined ? { invocationId } : {}),
        },
        name,
        args,
      );
    },
    endTurn(turnId: string) {
      if (!disposed) input.broker.endTurn(input.threadId, turnId, generation);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      input.broker.releaseSession(input.threadId, generation);
      geometry.dispatcher.invalidate();
      geometry.clear();
      off();
      automationEventSanitizer.clear(input.threadId);
      release();
    },
  };
}
export type ComputerSessionScope = ReturnType<typeof createComputerSessionScope>;
