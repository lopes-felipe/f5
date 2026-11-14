type RevealableWindow = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
};

/** Authorization precedes window lookup; a renderer can reveal only its own window. */
export function revealSenderWindow(
  authorize: () => void,
  senderWindow: () => RevealableWindow | null,
  activateApp: () => void = () => undefined,
) {
  authorize();
  const window = senderWindow();
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  activateApp();
  // Target this profile's window explicitly after application-wide macOS activation.
  window.focus();
}
