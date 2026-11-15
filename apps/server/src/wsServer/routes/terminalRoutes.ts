import { WS_METHODS } from "@t3tools/contracts";
import { Effect, Struct } from "effect";

import type { TerminalError, TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import type { RouteTable } from "./routeTable.ts";

type TerminalMethod =
  | typeof WS_METHODS.terminalSnapshot
  | typeof WS_METHODS.terminalOpen
  | typeof WS_METHODS.terminalWrite
  | typeof WS_METHODS.terminalResize
  | typeof WS_METHODS.terminalClear
  | typeof WS_METHODS.terminalRestart
  | typeof WS_METHODS.terminalClose;

export interface TerminalRouteDependencies<R, E> {
  readonly terminals: Pick<
    TerminalManagerShape,
    "snapshot" | "open" | "write" | "resize" | "clear" | "restart" | "close"
  >;
  /**
   * Runs an action that starts a shell for a thread. The server refuses it for
   * a deleted thread and holds the thread's worktree in place while it runs.
   * Only opening and restarting start a shell; the other requests act on one
   * that exists, or on none.
   */
  readonly startingShellFor: <A>(
    threadId: string,
    action: Effect.Effect<A, TerminalError>,
  ) => Effect.Effect<A, TerminalError | E, R>;
}

const withoutTag = <Body extends { readonly _tag: string }>(body: Body) =>
  Struct.omit(body, ["_tag"]);

/**
 * A thread's terminals. A `TerminalError` is passed on as it is, not as a
 * `RouteRequestError`: see `RouteHandler` for what the client then reads.
 */
export const terminalRoutes = <R = never, E = never>({
  terminals,
  startingShellFor,
}: TerminalRouteDependencies<R, E>): RouteTable<TerminalMethod, R, TerminalError | E> => ({
  [WS_METHODS.terminalSnapshot]: (body) => terminals.snapshot(withoutTag(body)),
  [WS_METHODS.terminalOpen]: (body) => {
    const input = withoutTag(body);
    return startingShellFor(input.threadId, terminals.open(input));
  },
  [WS_METHODS.terminalWrite]: (body) => terminals.write(withoutTag(body)),
  [WS_METHODS.terminalResize]: (body) => terminals.resize(withoutTag(body)),
  [WS_METHODS.terminalClear]: (body) => terminals.clear(withoutTag(body)),
  [WS_METHODS.terminalRestart]: (body) => {
    const input = withoutTag(body);
    return startingShellFor(input.threadId, terminals.restart(input));
  },
  [WS_METHODS.terminalClose]: (body) => terminals.close(withoutTag(body)),
});
