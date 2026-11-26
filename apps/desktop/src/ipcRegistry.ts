import type { IpcMainInvokeEvent } from "electron";

export interface DesktopIpcMainLike {
  readonly removeHandler: (channel: string) => void;
  readonly handle: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: ReadonlyArray<unknown>) => unknown,
  ) => void;
}

export interface AuthorizedAppIpcContext {
  readonly event: IpcMainInvokeEvent;
  readonly profileId: string;
}

export type AppIpcRegistrar = <Args extends ReadonlyArray<unknown>, Result>(
  channel: string,
  purpose: string,
  handler: (context: AuthorizedAppIpcContext, ...args: Args) => Result,
) => void;

/**
 * Registers desktop IPC `handle` channels behind a single mandatory F5 app main-frame
 * authorization gate so preview webviews, HTML sandboxes, and child frames cannot
 * invoke privileged desktop actions.
 */
export function createAppIpcRegistrar(input: {
  readonly ipcMain: DesktopIpcMainLike;
  readonly authorize: (event: IpcMainInvokeEvent, purpose: string) => string;
}): AppIpcRegistrar {
  return (channel, purpose, handler) => {
    input.ipcMain.removeHandler(channel);
    input.ipcMain.handle(channel, (event, ...args) => {
      const profileId = input.authorize(event, purpose);
      return handler({ event, profileId }, ...(args as never));
    });
  };
}
