/** Only the main frame of a registered application renderer may manage updates. */
export function assertUpdateCaller(
  event: { sender: { id: number; mainFrame: unknown }; senderFrame: unknown },
  runtimeForRenderer: (id: number) => unknown,
): void {
  runtimeForRenderer(event.sender.id);
  if (event.senderFrame !== event.sender.mainFrame) throw new Error("Unauthorized update request");
}
