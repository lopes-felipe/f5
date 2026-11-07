import { Cause, Exit, Logger } from "effect";

// Connection tickets and DPoP proofs remain valid after the request that carried them.
const URL_CREDENTIAL_PARAMS = /(^|[?&"\s])(wsTicket|dpop)=[^&#"\\\s]*/g;

export const redactUrlCredentials = (text: string): string =>
  text.replace(URL_CREDENTIAL_PARAMS, "$1$2=<redacted>");

export function redactCauseCredentials(cause: Cause.Cause<unknown>): Cause.Cause<unknown> {
  if (cause.reasons.length === 0 || Cause.hasInterruptsOnly(cause)) return cause;
  const pretty = Cause.pretty(cause);
  const redacted = redactUrlCredentials(pretty);
  return redacted === pretty ? cause : Cause.die(new Error(redacted));
}

export function redactExitCredentials(
  exit: Exit.Exit<unknown, unknown>,
): Exit.Exit<unknown, unknown> {
  if (Exit.isSuccess(exit)) return exit;
  const cause = redactCauseCredentials(exit.cause);
  return cause === exit.cause ? exit : Exit.failCause(cause);
}

export const redactingCredentials = <Output>(logger: Logger.Logger<unknown, Output>) =>
  Logger.make<unknown, Output>((options) =>
    logger.log({ ...options, cause: redactCauseCredentials(options.cause) }),
  );
