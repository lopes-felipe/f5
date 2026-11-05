import { Schema } from "effect";
import {
  ComputerAccessAnswer,
  ComputerPermission,
  RememberedComputerConsent,
  type RememberedComputerConsentEntry,
  type ComputerAutomationBackendStatus,
} from "@t3tools/contracts";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  isAlwaysAllowableIntegration,
  type AlwaysAllowableIntegration,
} from "./IntegrationConsentStore";
import { requestComputerPermission, openComputerPermissionSettings } from "./permissions";

export function registerComputerIpc(
  ipc: IpcMain,
  input: {
    authorize: (event: IpcMainInvokeEvent) => string;
    status: () => ComputerAutomationBackendStatus;
    retry: () => void | Promise<void>;
    answer: (profileId: string, answer: ComputerAccessAnswer) => void | Promise<void>;
    pause: (profileId: string, threadId: string, paused: boolean) => void | Promise<void>;
    /** Listing and revoking only: only main's native dialog grants "always allow". */
    integrationConsents?: {
      list: (profileId: string) => ReadonlyArray<AlwaysAllowableIntegration>;
      revoke: (profileId: string, integration: AlwaysAllowableIntegration) => void;
    };
    computerConsents?: {
      list: (profileId: string) => ReadonlyArray<RememberedComputerConsentEntry>;
      revoke: (profileId: string, consent: RememberedComputerConsent) => void;
    };
  },
): void {
  const register = (
    name: string,
    handler: (profileId: string, args: ReadonlyArray<unknown>) => unknown,
  ) => {
    ipc.removeHandler(`desktop-computer:${name}`);
    ipc.handle(`desktop-computer:${name}`, (event, ...args: unknown[]) =>
      handler(input.authorize(event), args),
    );
  };
  register("status", () => input.status());
  register("request-permission", (_profile, args) =>
    requestComputerPermission(Schema.decodeUnknownSync(ComputerPermission)(args[0])),
  );
  register("open-permissions", (_profile, args) =>
    openComputerPermissionSettings(Schema.decodeUnknownSync(ComputerPermission)(args[0])),
  );
  register("retry", () => input.retry());
  register("answer", (profile, args) => {
    if (args[1] !== true) throw new Error("Computer access requires a trusted user gesture.");
    return input.answer(profile, Schema.decodeUnknownSync(ComputerAccessAnswer)(args[0]));
  });
  register("pause", (profile, args) => {
    if (typeof args[0] !== "string" || args[0].length === 0 || typeof args[1] !== "boolean")
      throw new Error("Invalid pause request.");
    if (!args[1] && args[2] !== true)
      throw new Error("Resuming computer control requires a trusted user gesture.");
    return input.pause(profile, args[0], args[1]);
  });
  register("integration-consents", (profile) => [
    ...(input.integrationConsents?.list(profile) ?? []),
  ]);
  register("remembered-consents", (profile) => input.computerConsents?.list(profile) ?? []);
  register("revoke-remembered-consent", (profile, args) => {
    const consent = Schema.decodeUnknownSync(RememberedComputerConsent)(args[0], {
      onExcessProperty: "error",
    });
    input.computerConsents?.revoke(profile, consent);
  });
  register("revoke-integration-consent", (profile, args) => {
    if (!isAlwaysAllowableIntegration(args[0])) throw new Error("Invalid integration.");
    input.integrationConsents?.revoke(profile, args[0]);
  });
}
