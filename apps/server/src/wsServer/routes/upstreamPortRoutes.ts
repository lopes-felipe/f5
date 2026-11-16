import { UPSTREAM_PORTS_WS_METHODS as METHODS } from "@t3tools/contracts";
import { Effect, Struct } from "effect";

import { RouteRequestError } from "../../turnSubmissionErrors.ts";
import type { UpstreamPortsError, UpstreamPortsService } from "../../upstreamPorts/service.ts";
import type { RouteTable } from "./routeTable.ts";

type UpstreamPortMethod = (typeof METHODS)[keyof typeof METHODS];

/** A service member with its answer left unread: the routes pass it on as it is. */
type AnswerUnread<Member> = Member extends (
  ...args: infer Args
) => Effect.Effect<unknown, UpstreamPortsError>
  ? (...args: Args) => Effect.Effect<unknown, UpstreamPortsError>
  : Effect.Effect<unknown, UpstreamPortsError>;

/**
 * What the routes use of the Upstream Ports service. Each request is answered
 * by the service member of the same name, so a new method needs both.
 */
export type UpstreamPortRouteService = {
  readonly [Name in keyof typeof METHODS]: AnswerUnread<UpstreamPortsService[Name]>;
};

// Distributes over a request that is a union of shapes, where a plain `Omit` would merge them.
type WithoutTag<Body> = Body extends { readonly _tag: string } ? Omit<Body, "_tag"> : never;
const withoutTag = <Body extends { readonly _tag: string }>(body: Body) =>
  Struct.omit(body, ["_tag"]) as WithoutTag<Body>;

/**
 * Upstream Ports: the ledger of upstream changes, its decisions and the port
 * queue. `service` is null on a server that has no Git to read upstream with;
 * every request is then refused.
 */
export const upstreamPortRoutes = (
  service: UpstreamPortRouteService | null,
): RouteTable<UpstreamPortMethod> => {
  const answer = (
    ask: (upstream: UpstreamPortRouteService) => Effect.Effect<unknown, UpstreamPortsError>,
  ) =>
    Effect.suspend(() =>
      service === null
        ? Effect.fail(new RouteRequestError({ message: "Upstream Ports is unavailable." }))
        : ask(service).pipe(
            Effect.mapError(
              (error) => new RouteRequestError({ message: error.message, code: error.code }),
            ),
          ),
    );
  return {
    [METHODS.listProjects]: () => answer((upstream) => upstream.listProjects),
    [METHODS.getOverview]: ({ projectId }) => answer((upstream) => upstream.getOverview(projectId)),
    [METHODS.listTopics]: (body) => answer((upstream) => upstream.listTopics(withoutTag(body))),
    [METHODS.listTopicIds]: (body) => answer((upstream) => upstream.listTopicIds(withoutTag(body))),
    [METHODS.getTopic]: (body) => answer((upstream) => upstream.getTopic(withoutTag(body))),
    [METHODS.getTopicFiles]: (body) =>
      answer((upstream) => upstream.getTopicFiles(withoutTag(body))),
    [METHODS.decide]: (body) => answer((upstream) => upstream.decide(withoutTag(body))),
    [METHODS.acceptSuggestions]: (body) =>
      answer((upstream) => upstream.acceptSuggestions(withoutTag(body))),
    [METHODS.undoDecisions]: (body) =>
      answer((upstream) => upstream.undoDecisions(withoutTag(body))),
    [METHODS.expireBacklog]: (body) =>
      answer((upstream) => upstream.expireBacklog(withoutTag(body))),
    [METHODS.run]: (body) => answer((upstream) => upstream.run(withoutTag(body))),
    [METHODS.startPort]: (body) => answer((upstream) => upstream.startPort(withoutTag(body))),
    [METHODS.previewPortGroups]: (body) =>
      answer((upstream) => upstream.previewPortGroups(withoutTag(body))),
    [METHODS.enqueuePort]: (body) => answer((upstream) => upstream.enqueuePort(withoutTag(body))),
    [METHODS.getPortQueue]: (body) => answer((upstream) => upstream.getPortQueue(withoutTag(body))),
    [METHODS.dequeuePort]: (body) => answer((upstream) => upstream.dequeuePort(withoutTag(body))),
    [METHODS.controlPortQueue]: (body) =>
      answer((upstream) => upstream.controlPortQueue(withoutTag(body))),
    [METHODS.unlinkPort]: (body) => answer((upstream) => upstream.unlinkPort(withoutTag(body))),
    [METHODS.retryPortReview]: (body) =>
      answer((upstream) => upstream.retryPortReview(withoutTag(body))),
    [METHODS.getPortPrompt]: (body) =>
      answer((upstream) => upstream.getPortPrompt(withoutTag(body))),
    [METHODS.resolvePublication]: (body) =>
      answer((upstream) => upstream.resolvePublication(withoutTag(body))),
    [METHODS.addRemote]: ({ projectId }) => answer((upstream) => upstream.addRemote(projectId)),
    [METHODS.takeOverWriter]: ({ projectId }) =>
      answer((upstream) => upstream.takeOverWriter(projectId)),
  };
};
