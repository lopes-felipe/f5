import type { ComputerAccessAnswer, ComputerAccessRequested } from "@t3tools/contracts";

/** Scripted consent is restricted to this run's synthetic fixture, never user apps. */
export function rehearsalAccessAnswer(
  request: ComputerAccessRequested,
  incarnation: string,
  fixtureAppId: string,
): ComputerAccessAnswer {
  const fixtureOnly =
    request.kind === "apps" &&
    request.apps.length === 1 &&
    request.apps[0]?.appId === fixtureAppId &&
    request.apps[0]?.tier === "full";
  return {
    requestId: request.requestId,
    backendIncarnation: incarnation,
    decisions: request.apps.map((app) => ({
      appId: app.appId,
      allow: fixtureOnly,
      allowTyping: false,
      remember: false,
    })),
    allowSessionActions: request.kind === "session-actions" && request.apps.length === 0,
  };
}
