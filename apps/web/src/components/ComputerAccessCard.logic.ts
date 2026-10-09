import type { ComputerAccessPush, ComputerAccessAnswer } from "@t3tools/contracts";
export function initialComputerAccessDecisions(
  request: typeof ComputerAccessPush.Type,
): ComputerAccessAnswer["decisions"] {
  return request.apps.map((app) => ({
    appId: app.appId,
    allow: app.tier !== "blocked",
    allowTyping: false,
    remember: false,
  }));
}
export function computerAccessAnswer(
  request: typeof ComputerAccessPush.Type,
  decisions: ComputerAccessAnswer["decisions"],
  allow: boolean,
): ComputerAccessAnswer {
  return {
    requestId: request.requestId,
    backendIncarnation: request.backendIncarnation,
    decisions: request.apps.map((app) => {
      const decision = decisions.find((entry) => entry.appId === app.appId);
      const selected = allow && app.tier !== "blocked" && decision?.allow === true;
      return {
        appId: app.appId,
        allow: selected,
        allowTyping: selected && app.tier === "click" && decision?.allowTyping === true,
        remember: selected && decision?.remember === true,
      };
    }),
    ...(request.kind === "session-actions" ? { allowSessionActions: allow } : {}),
  };
}
