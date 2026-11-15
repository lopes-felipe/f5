import { AGENT_BRIDGE_WS_METHODS as METHODS } from "@t3tools/contracts";
import { Effect, Struct } from "effect";

import type { AgentBridgeServiceShape } from "../../agentBridge/AgentBridgeService.ts";
import { RouteRequestError } from "../../turnSubmissionErrors.ts";
import type { RouteTable } from "./routeTable.ts";

type AgentBridgeMethod = (typeof METHODS)[keyof typeof METHODS];

const withoutTag = <Body extends { readonly _tag: string }>(body: Body) =>
  Struct.omit(body, ["_tag"]);

const answer = <A>(result: Effect.Effect<A, { readonly message: string }>) =>
  result.pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));

/**
 * The Agent Bridge as the app's own user sees it: its state, which clients may
 * schedule, and the tasks those clients were given. Pausing, resuming and
 * cancelling a task are one operation on the service, told apart by the method.
 */
export const agentBridgeRoutes = (
  bridge: AgentBridgeServiceShape,
): RouteTable<AgentBridgeMethod> => ({
  [METHODS.getState]: () => bridge.getState,
  [METHODS.setSchedulingGrant]: (body) => answer(bridge.setSchedulingGrant(withoutTag(body))),
  [METHODS.getTasks]: (body) => answer(bridge.tasks.getTasks(withoutTag(body))),
  [METHODS.getTask]: ({ taskId }) => answer(bridge.tasks.getTask(taskId)),
  [METHODS.getTaskActivities]: (body) => answer(bridge.tasks.getTaskActivities(withoutTag(body))),
  [METHODS.createTask]: (body) => answer(bridge.tasks.createTask(withoutTag(body))),
  [METHODS.replyToTask]: (body) => answer(bridge.tasks.replyToTask(withoutTag(body))),
  [METHODS.pauseTask]: (body) => answer(bridge.tasks.controlTask("pause", withoutTag(body))),
  [METHODS.resumeTask]: (body) => answer(bridge.tasks.controlTask("resume", withoutTag(body))),
  [METHODS.cancelTask]: (body) => answer(bridge.tasks.controlTask("cancel", withoutTag(body))),
});
