/** CLI control is optional: a socket failure must never prevent opening the app. */
export function createWindowWithOptionalControl<T>(options: {
  createWindow: () => T;
  startControl: () => Promise<() => Promise<void>>;
  onReady: (stop: () => Promise<void>) => void;
  onError: (error: unknown) => void;
}): T {
  const window = options.createWindow();
  void Promise.resolve().then(options.startControl).then(options.onReady).catch(options.onError);
  return window;
}
