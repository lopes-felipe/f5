import { EventEmitter } from "node:events";
import type {
  ComputerAutomationRequest,
  DesktopComputerHostMessage,
  ComputerApp,
  ComputerDisplay,
} from "@t3tools/contracts";
import { DesktopComputerHost } from "../../src/computer/DesktopComputerHost";
import { ComputerAutomationBrokerRuntime } from "../../src/computer/ComputerAutomationBroker";

export const fixtureDisplay: ComputerDisplay = {
  displayId: "test-display",
  geometryGeneration: "test-geometry",
  primary: true,
  nativeBounds: { x: 0, y: 0, width: 1, height: 1 },
  pixelSize: { width: 1, height: 1 },
  modelSize: { width: 1, height: 1 },
  rotation: 0,
};
export const fixtureApp: ComputerApp = {
  appId: "com.apple.TextEdit",
  name: "F5 transport test app",
  tier: "full",
  running: true,
  frontmost: true,
};
export const fixtureScreenshot = {
  displayId: fixtureDisplay.displayId,
  geometryGeneration: fixtureDisplay.geometryGeneration,
  modelSize: { width: 1, height: 1 },
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  hiddenContent: true,
};
/** Protocol fixture only: never injects OS input and never approves production consent. */
export async function computerHostFixture() {
  const seen: ComputerAutomationRequest[] = [];
  let consentCount = 0;
  const ipc = Object.assign(new EventEmitter(), {
    connected: true,
    send: (raw: unknown, callback: (error: Error | null) => void) => {
      const message = raw as DesktopComputerHostMessage;
      callback(null);
      queueMicrotask(() => {
        if (message.type === "hello")
          ipc.emit("message", {
            type: "status",
            status: { available: true, displays: [fixtureDisplay] },
          });
        if (message.type === "accessRequested") {
          consentCount++;
          ipc.emit("message", {
            type: "accessAnswer",
            answer: {
              requestId: message.request.requestId,
              backendIncarnation: "test-incarnation",
              decisions: message.request.apps.map((app) => ({
                appId: app.appId,
                allow: true,
                allowTyping: false,
                remember: false,
              })),
              allowSessionActions: true,
            },
          });
        }
        if (message.type === "leaseAcquire")
          ipc.emit("message", {
            type: "response",
            requestId: message.requestId,
            result: { ...message.holder, executionGeneration: 7 },
          });
        if (message.type === "request") {
          const request = message.request;
          seen.push(request);
          const result =
            request.op === "resolveApps" || request.op === "listApps"
              ? [fixtureApp]
              : request.op === "screenshot"
                ? fixtureScreenshot
                : {
                    displayId: fixtureDisplay.displayId,
                    geometryGeneration: fixtureDisplay.geometryGeneration,
                    frontmostApp: fixtureApp,
                    cursor: { displayId: fixtureDisplay.displayId, x: 0, y: 0 },
                    ...("screenshot" in request && request.screenshot
                      ? { screenshot: fixtureScreenshot }
                      : {}),
                  };
          ipc.emit("message", { type: "response", requestId: request.requestId, result });
        }
      });
      return true;
    },
  });
  const host = new DesktopComputerHost("test-profile", "test-incarnation", ipc, true);
  const broker = new ComputerAutomationBrokerRuntime(host, {
    platform: "darwin",
    resolve: async (threadId, sessionGeneration, provider) => ({
      threadId,
      sessionGeneration,
      provider,
      projectId: "test-project",
      turnId: "test-turn",
      threadTitle: "Transport fixture",
      runtimeMode: "approval-required",
      interactionMode: "default",
      policy: {
        computerUse: true,
        claudeInChrome: false,
        previewAutomation: true,
        externalHosts: [],
      },
    }),
    storage: { load: async () => [], save: async () => {} },
  });
  await broker.initialize();
  await Promise.resolve();
  return { broker, seen, consentCount: () => consentCount };
}
