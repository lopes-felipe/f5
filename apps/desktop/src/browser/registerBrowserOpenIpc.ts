import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  BROWSER_OPEN_ANSWER_CHANNEL,
  BROWSER_OPEN_CURRENT_CHANNEL,
  BROWSER_OPEN_SHOWN_CHANNEL,
  type InAppBrowserOpenPrompt,
} from "./BrowserOpenPrompt";

/** Every channel is scoped to the sender's profile; the prompt validates request and choice. */
export function registerBrowserOpenIpc(
  ipc: IpcMain,
  input: { authorize: (event: IpcMainInvokeEvent) => string; prompt: InAppBrowserOpenPrompt },
): void {
  const register = (name: string, handler: (profileId: string, args: unknown[]) => unknown) => {
    ipc.removeHandler(name);
    ipc.handle(name, (event, ...args: unknown[]) => handler(input.authorize(event), args));
  };
  register(BROWSER_OPEN_CURRENT_CHANNEL, (profileId) => input.prompt.current(profileId));
  register(BROWSER_OPEN_SHOWN_CHANNEL, (profileId, args) =>
    input.prompt.acknowledge(profileId, args[0]),
  );
  register(BROWSER_OPEN_ANSWER_CHANNEL, (profileId, args) =>
    input.prompt.answer(profileId, args[0], args[1], args[2]),
  );
}
