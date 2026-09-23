import {
  beginProtocolUpload,
  requireProtocolUpgrade,
  resetProtocolStateForTests,
  reloadForProtocolUpgrade,
} from "../protocolState";
import "../index.css";

import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  acknowledgeSlowRpcRequest,
  resetRequestLatencyStateForTests,
  SLOW_RPC_THRESHOLD_MS,
  trackSlowRpcRequestSent,
} from "../requestLatencyState";
import {
  noteWsConnectionAttempt,
  noteWsConnectionClosed,
  noteWsConnectionOpened,
  registerWsTransportReconnectHandler,
  resetWsConnectionStateForTests,
} from "../wsConnectionState";
import { WEB_LOCAL_FLAG_KEYS } from "../webLocalFlags";
import {
  SlowRpcWarningToastCoordinator,
  WebSocketConnectionSurface,
} from "./WebSocketConnectionSurface";
import { ToastProvider } from "./ui/toast";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useParams: () => null,
  };
});

vi.mock("../protocolState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../protocolState")>();
  return { ...actual, reloadForProtocolUpgrade: vi.fn() };
});

function enableFlag(key: (typeof WEB_LOCAL_FLAG_KEYS)[keyof typeof WEB_LOCAL_FLAG_KEYS]) {
  localStorage.setItem(key, "true");
}

async function mountSurface(children: ReactNode = <div>Workspace content</div>) {
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

describe("WebSocketConnectionSurface", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    document.body.innerHTML = "";
    resetRequestLatencyStateForTests();
    resetWsConnectionStateForTests();
    resetProtocolStateForTests();
    vi.mocked(reloadForProtocolUpgrade).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows upgrades without unmounting drafts and waits for uploads before reloading", async () => {
    const finishUpload = beginProtocolUpload();
    const mounted = await mountSurface(<textarea defaultValue="saved draft" />);
    try {
      const draft = mounted.host.querySelector("textarea");
      requireProtocolUpgrade();
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain("F5 was updated. Reload to continue."),
      );
      expect(document.body.textContent).toContain("Waiting for uploads");
      await vi.advanceTimersByTimeAsync(1000);
      expect(reloadForProtocolUpgrade).not.toHaveBeenCalled();
      expect(mounted.host.querySelector("textarea")).toBe(draft);
      expect(draft?.value).toBe("saved draft");
      finishUpload();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Reloading"));
      await vi.advanceTimersByTimeAsync(300);
      expect(reloadForProtocolUpgrade).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the overlay hidden while connecting or connected", async () => {
    enableFlag(WEB_LOCAL_FLAG_KEYS.wsDisconnectSurfaceEnabled);
    noteWsConnectionAttempt();

    const mounted = await mountSurface();
    try {
      await vi.waitFor(() => {
        expect(document.body.textContent).not.toContain("Connection to");
      });

      noteWsConnectionOpened();

      await vi.waitFor(() => {
        expect(document.body.textContent).not.toContain("Connection to");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the overlay for disconnected and reconnecting states without unmounting children", async () => {
    enableFlag(WEB_LOCAL_FLAG_KEYS.wsDisconnectSurfaceEnabled);
    noteWsConnectionAttempt();
    noteWsConnectionOpened();
    noteWsConnectionClosed();

    const mounted = await mountSurface(<div>Persistent child</div>);
    try {
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Reconnecting to");
        expect(document.body.textContent).toContain("Persistent child");
      });

      resetWsConnectionStateForTests();
      resetProtocolStateForTests();
      vi.mocked(reloadForProtocolUpgrade).mockClear();
      noteWsConnectionAttempt();
      noteWsConnectionClosed();

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Connection to");
        expect(document.body.textContent).toContain("Persistent child");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("respects the disconnect surface flag", async () => {
    noteWsConnectionAttempt();
    noteWsConnectionClosed();

    const mounted = await mountSurface();
    try {
      await vi.waitFor(() => {
        expect(document.body.textContent).not.toContain("Connection to");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("retries the websocket connection from the action button", async () => {
    enableFlag(WEB_LOCAL_FLAG_KEYS.wsDisconnectSurfaceEnabled);
    noteWsConnectionAttempt();
    noteWsConnectionClosed();

    const reconnect = vi.fn(async () => undefined);
    const unregister = registerWsTransportReconnectHandler(reconnect);
    const mounted = await mountSurface();

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Retry now");
      });

      const retryButton = Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Retry now"),
      );
      expect(retryButton).toBeTruthy();
      retryButton?.click();

      await vi.waitFor(() => {
        expect(reconnect).toHaveBeenCalledTimes(1);
      });
    } finally {
      unregister();
      await mounted.cleanup();
    }
  });

  it("shows the slow warning toast only for tracked allowlisted requests", async () => {
    enableFlag(WEB_LOCAL_FLAG_KEYS.slowRpcWarningEnabled);
    noteWsConnectionAttempt();
    noteWsConnectionOpened();

    const mounted = await mountSurface();
    try {
      trackSlowRpcRequestSent("ignored", WS_METHODS.gitRunStackedAction);
      vi.advanceTimersByTime(SLOW_RPC_THRESHOLD_MS);

      await vi.waitFor(() => {
        expect(document.body.textContent).not.toContain(
          "Sending your request is taking longer than expected.",
        );
      });

      trackSlowRpcRequestSent("tracked", ORCHESTRATION_WS_METHODS.dispatchCommand);
      vi.advanceTimersByTime(SLOW_RPC_THRESHOLD_MS);

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain(
          "Sending your request is taking longer than expected.",
        );
      });

      acknowledgeSlowRpcRequest("tracked");

      await vi.waitFor(() => {
        expect(document.body.textContent).not.toContain(
          "Sending your request is taking longer than expected.",
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
