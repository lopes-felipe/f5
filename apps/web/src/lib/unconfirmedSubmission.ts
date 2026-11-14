import { WsRequestError } from "../wsTransport";

/** Request errors the transport raises before sending anything: the server never saw them. */
const UNSENT_REQUEST_CODES: ReadonlySet<string> = new Set([
  "ConnectionNotReady",
  "QueueExpired",
  "RequestTooLarge",
  "RpcQueueFull",
]);

/**
 * Whether a failed submission may still have been accepted. Two failures are certain: the
 * server answered with an error, or the transport refused the request before sending it.
 * Anything else (a closed socket, a response that timed out while the server was still
 * working, a response that could not be read) leaves the outcome unknown.
 */
export function submissionOutcomeUnknown(error: unknown): boolean {
  if (!(error instanceof WsRequestError)) return true;
  if (error.origin === "server") return false;
  return error.code === undefined || !UNSENT_REQUEST_CODES.has(error.code);
}

/**
 * For a message to an existing thread: past this age a repeat is a new message ("continue",
 * sent again later), not a retry of the one whose response was lost.
 */
export const UNCONFIRMED_SUBMISSION_TTL_MS = 5 * 60_000;

interface UnconfirmedSubmission<Command> {
  readonly signature: string;
  readonly command: Command;
  readonly at: number;
}

/**
 * Submissions whose outcome is not known yet, one per slot. Sending the same thing again
 * (the same `signature` in the same slot) resends the very same command, so the server,
 * which replays a submission id it has already seen, never delivers the message twice.
 * That covers a retry after a lost response and a second send while the first is in flight.
 *
 * `ttlMs` bounds how long a lost send is still taken for the same one; without it the
 * command is kept until the server answers or something else is sent in its slot.
 */
export function createUnconfirmedSubmissions<Command>(options: { readonly ttlMs?: number } = {}) {
  const ttlMs = options.ttlMs ?? Number.POSITIVE_INFINITY;
  const bySlot = new Map<string, UnconfirmedSubmission<Command>>();
  return {
    /**
     * Sends the slot's unconfirmed command when it matches `signature`, else the one
     * `build` returns. The command is forgotten once the server answered, either way.
     */
    async submit<Result>(input: {
      readonly slot: string;
      readonly signature: string;
      readonly build: () => Command;
      readonly send: (command: Command) => Promise<Result>;
    }): Promise<{ readonly command: Command; readonly result: Result }> {
      const retained = bySlot.get(input.slot);
      const reusable =
        retained !== undefined &&
        retained.signature === input.signature &&
        Date.now() - retained.at < ttlMs;
      const entry = reusable
        ? retained
        : { signature: input.signature, command: input.build(), at: Date.now() };
      bySlot.set(input.slot, entry);
      const forget = () => {
        if (bySlot.get(input.slot) === entry) bySlot.delete(input.slot);
      };
      let result: Result;
      try {
        result = await input.send(entry.command);
      } catch (error) {
        if (!submissionOutcomeUnknown(error)) forget();
        throw error;
      }
      forget();
      return { command: entry.command, result };
    },
    clear(): void {
      bySlot.clear();
    },
  };
}
