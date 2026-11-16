import type { ReactNode } from "react";
import { render } from "vitest-browser-react";
import {
  SlowRpcWarningToastCoordinator,
  WebSocketConnectionSurface,
} from "../components/WebSocketConnectionSurface";
import { ToastProvider } from "../components/ui/toast";

export async function mountConnectionSurface(children: ReactNode = <div>Workspace content</div>) {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <ToastProvider>
      <SlowRpcWarningToastCoordinator />
      <WebSocketConnectionSurface>{children}</WebSocketConnectionSurface>
    </ToastProvider>,
    { container: host },
  );
  return {
    host,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}
