import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";

/** Consent IPC answers only F5's own app main frame; returns the profile that window shows. */
export function appMainFrameProfile(
  event: Pick<IpcMainInvokeEvent | IpcMainEvent, "sender" | "senderFrame">,
  input: {
    registered: (webContentsId: number) => boolean;
    profile: (webContentsId: number) => string | undefined;
    expectedOrigin: string;
    purpose: string;
  },
): string {
  if (
    !input.registered(event.sender.id) ||
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame ||
    event.senderFrame.origin !== input.expectedOrigin
  )
    throw new Error(`${input.purpose} require an F5 app main frame.`);
  const profileId = input.profile(event.sender.id);
  if (!profileId) throw new Error("Renderer does not own a profile.");
  return profileId;
}
