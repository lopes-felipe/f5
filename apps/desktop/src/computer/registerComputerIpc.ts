import { Schema } from "effect";
import {
  ComputerAccessAnswer,
  ComputerPermission,
  type ComputerAutomationBackendStatus,
} from "@t3tools/contracts";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { requestComputerPermission, openComputerPermissionSettings } from "./permissions";

export function registerComputerIpc(
  ipc: IpcMain,
  input: {
    authorize: (event: IpcMainInvokeEvent) => string;
    status: () => ComputerAutomationBackendStatus;
    retry: () => void;
    answer: (profileId: string, answer: ComputerAccessAnswer) => void;
    pause: (profileId: string, threadId: string, paused: boolean) => void;
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
    input.answer(profile, Schema.decodeUnknownSync(ComputerAccessAnswer)(args[0]));
  });
  register("pause", (profile, args) => {
    if (typeof args[0] !== "string" || args[0].length === 0 || typeof args[1] !== "boolean")
      throw new Error("Invalid pause request.");
    input.pause(profile, args[0], args[1]);
  });
}
