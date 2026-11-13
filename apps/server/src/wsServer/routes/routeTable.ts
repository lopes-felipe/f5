import type { WebSocketRequest } from "@t3tools/contracts";
import { Effect } from "effect";
import type { WebSocket } from "ws";

import { RouteRequestError } from "../../turnSubmissionErrors.ts";

/**
 * Route tables: one handler per WebSocket method, grouped by domain in a module
 * that takes its dependencies as an argument. `routeRequest` in `wsServer.ts`
 * consults the tables before its `switch`, so a domain can move out of the
 * switch whole and its routes can be tested without starting a server.
 */

export type RouteBody = WebSocketRequest["body"];
export type RouteMethod = RouteBody["_tag"];
export type RouteBodyOf<Method extends RouteMethod> = Extract<RouteBody, { readonly _tag: Method }>;

/** Answers one method. The value is sent as the response; a failure is sent as its message. */
export type RouteHandler<Method extends RouteMethod, R = never> = (
  body: RouteBodyOf<Method>,
  ws: WebSocket,
) => Effect.Effect<unknown, RouteRequestError, R>;

export type RouteTable<Method extends RouteMethod, R = never> = {
  readonly [Tag in Method]: RouteHandler<Tag, R>;
};

/**
 * Whether `table` answers this request. In the `false` branch the body is
 * narrowed to the methods the table does not own, which keeps the exhaustive
 * `switch` in `routeRequest` honest: a method must be in a table or a `case`.
 */
export const tableAnswers = <Method extends RouteMethod, R>(
  table: RouteTable<Method, R>,
  body: RouteBody,
): body is RouteBodyOf<Method> => Object.hasOwn(table, body._tag);

export const answerFromTable = <Method extends RouteMethod, R>(
  table: RouteTable<Method, R>,
  body: RouteBodyOf<Method>,
  ws: WebSocket,
): Effect.Effect<unknown, RouteRequestError, R> =>
  // The table maps each tag to the handler for that tag's body; TypeScript
  // cannot follow that pairing through an indexed lookup.
  (table[body._tag as Method] as unknown as RouteHandler<RouteMethod, R>)(body, ws);

/** Runs a promise-returning operation; a rejection becomes the route's error message. */
export const routePromise = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new RouteRequestError({ message: cause instanceof Error ? cause.message : String(cause) }),
  });
