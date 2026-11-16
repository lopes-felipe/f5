import { Cause } from "effect";

/**
 * What a client is told when a request fails with an error the server has no
 * specific answer for: the messages of the errors, with no stack trace.
 * `Cause.pretty` prints where each error was raised, which put the server's
 * source paths into text the app shows to the user. The log keeps the trace.
 */
export const routeFailureMessage = (cause: Cause.Cause<unknown>): string => {
  if (Cause.hasInterruptsOnly(cause)) return "The request was interrupted before it finished.";
  const messages: string[] = [];
  for (const error of Cause.prettyErrors(cause)) {
    // An error with no message of its own still has a name worth showing,
    // unless that name is only "Error".
    const message = error.message.trim() || (error.name === "Error" ? "" : error.name);
    if (message && !messages.includes(message)) messages.push(message);
  }
  return messages.length > 0 ? messages.join("\n") : "The request failed.";
};
