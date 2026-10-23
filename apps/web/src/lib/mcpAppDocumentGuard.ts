/** A navigation keeps the iframe WindowProxy, so source equality alone cannot authorize app calls. */
export function makeMcpAppDocumentGuard(options: {
  nonce: string;
  frameWindow: () => Window | null;
  onLeave: () => void;
  onEscape: () => void;
}) {
  let port: MessagePort | null = null;
  let disposed = false;
  let next = 0;
  const pending = new Map<
    string,
    { finish: (value: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const dispose = () => {
    disposed = true;
    port?.close();
    port = null;
    for (const { finish, timer } of pending.values()) {
      clearTimeout(timer);
      finish(false);
    }
    pending.clear();
  };
  const accept = (event: MessageEvent) => {
    if (
      disposed ||
      port ||
      event.source !== options.frameWindow() ||
      !event.isTrusted ||
      event.data?.f5McpDocument !== options.nonce ||
      !event.ports[0]
    )
      return false;
    port = event.ports[0];
    port.onmessage = (event) => {
      if (disposed) return;
      if (event.data?.leave === true) {
        dispose();
        options.onLeave();
        return;
      }
      if (event.data?.escape === true) options.onEscape();
      const id = event.data?.pong;
      if (typeof id !== "string") return;
      const request = pending.get(id);
      if (request) {
        pending.delete(id);
        clearTimeout(request.timer);
        request.finish(true);
      }
    };
    port.start();
    return true;
  };
  const check = () =>
    new Promise<boolean>((finish) => {
      if (disposed || !port || pending.size >= 16) {
        finish(false);
        return;
      }
      const id = String(next++);
      const timer = setTimeout(() => {
        pending.delete(id);
        finish(false);
      }, 1000);
      pending.set(id, { finish, timer });
      try {
        port.postMessage({ ping: id });
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        finish(false);
      }
    });
  return { accept, check, dispose };
}
