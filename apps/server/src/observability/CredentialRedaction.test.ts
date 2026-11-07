import { Cause, Effect, Exit, Logger } from "effect";
import { describe, expect, it } from "vitest";
import {
  redactCauseCredentials,
  redactExitCredentials,
  redactingCredentials,
  redactUrlCredentials,
} from "./CredentialRedaction.ts";

describe("connection credential redaction", () => {
  it.each([
    "wsTicket=ticket-secret&dpop=proof-secret&clientSurface=web",
    "/ws?wsTicket=ticket-secret&dpop=proof-secret&clientSurface=web",
    "RequestParseError (GET /ws?wsTicket=ticket-secret&dpop=proof-secret&clientSurface=web)",
    JSON.stringify({ url: "/ws?wsTicket=ticket-secret&dpop=proof-secret&clientSurface=web" }),
  ])("redacts credentials in %s", (text) => {
    const redacted = redactUrlCredentials(text);
    expect(redacted).toContain("wsTicket=<redacted>&dpop=<redacted>&clientSurface=web");
    expect(redacted).not.toContain("ticket-secret");
    expect(redacted).not.toContain("proof-secret");
  });

  it("preserves causes and exits that do not contain credentials", () => {
    for (const cause of [Cause.empty, Cause.interrupt(), Cause.die(new Error("ordinary failure"))])
      expect(redactCauseCredentials(cause)).toBe(cause);
    const success = Exit.succeed("result");
    const failure = Exit.fail("ordinary failure");
    expect(redactExitCredentials(success)).toBe(success);
    expect(redactExitCredentials(failure)).toBe(failure);
  });

  it("redacts causes before passing them to a console logger", async () => {
    const output: string[] = [];
    const logger = redactingCredentials(
      Logger.make((options) => output.push(Cause.pretty(options.cause))),
    );
    await Effect.runPromise(
      Effect.logError(
        Cause.die(new Error("GET /ws?wsTicket=ticket-secret&dpop=proof-secret")),
      ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false }))),
    );
    expect(output.join("\n")).toContain("wsTicket=<redacted>&dpop=<redacted>");
    expect(output.join("\n")).not.toContain("ticket-secret");
    expect(output.join("\n")).not.toContain("proof-secret");
  });
});
