import "../../index.css";
import {
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderAccountEvent,
} from "@t3tools/contracts";
import { authFailureKey } from "@t3tools/shared/usageLimit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { AuthFailureNotice } from "./AuthFailureNotice";

const mocks = vi.hoisted(() => ({
  loginStart: vi.fn(),
  cancel: vi.fn(async (_input: { handle: string }) => {}),
  resend: vi.fn(),
  toast: vi.fn(),
  listener: null as null | ((event: typeof ProviderAccountEvent.Type) => void),
}));
vi.mock("../../nativeApi", async (importOriginal) => {
  const api = {
    profiles: {
      loginStart: mocks.loginStart,
      cancel: mocks.cancel,
      input: vi.fn(async () => {}),
      logout: vi.fn(),
      accountStatus: vi.fn(),
    },
    nextTurnQueue: { resendAuthFailedTurn: mocks.resend },
  };
  return {
    ...(await importOriginal<typeof import("../../nativeApi")>()),
    readNativeApi: () => api,
  };
});
vi.mock("../../wsNativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../wsNativeApi")>()),
  onProviderAccountEvent: (listener: (event: typeof ProviderAccountEvent.Type) => void) => {
    mocks.listener = listener;
    return () => {
      if (mocks.listener === listener) mocks.listener = null;
    };
  },
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

const threadId = ThreadId.makeUnsafe("auth-thread");
const instanceId = ProviderInstanceId.makeUnsafe("claudeAgent");
const failure = {
  providerInstanceId: instanceId,
  turnId: TurnId.makeUnsafe("failed-turn"),
  occurredAt: "2026-11-22T12:59:00.000Z",
};

describe("AuthFailureNotice", () => {
  beforeEach(() => {
    mocks.loginStart.mockReset().mockResolvedValue({ handle: "login-1" });
    mocks.resend.mockReset().mockResolvedValue({ kind: "sent" });
    mocks.toast.mockReset();
    mocks.listener = null;
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("signs in with one click and resends the failed message once the login succeeds", async () => {
    const screen = await render(
      <AuthFailureNotice
        threadId={threadId}
        failure={failure}
        providerLabel="Claude"
        driver="claudeAgent"
        error="Claude login expired or is invalid. Run /login in this provider account, then retry."
        onDismiss={() => {}}
      />,
    );
    try {
      await expect.element(page.getByText("Your Claude login expired")).toBeVisible();
      await page.getByRole("button", { name: "Sign in again" }).click();
      await vi.waitFor(() => expect(mocks.loginStart).toHaveBeenCalledWith({ instanceId }));
      expect(mocks.resend).not.toHaveBeenCalled();

      // Another surface's login for the same account must not trigger the resend.
      mocks.listener?.({ handle: "someone-else", instanceId, type: "exited", data: "0" });
      expect(mocks.resend).not.toHaveBeenCalled();

      mocks.listener?.({ handle: "login-1", instanceId, type: "exited", data: "0" });
      await vi.waitFor(() =>
        expect(mocks.resend).toHaveBeenCalledWith({
          threadId,
          expectedFailureKey: authFailureKey(failure),
        }),
      );
      expect(mocks.resend).toHaveBeenCalledTimes(1);
      await vi.waitFor(() =>
        expect(mocks.toast).toHaveBeenCalledWith(
          expect.objectContaining({ type: "success", title: "Signed in to Claude" }),
        ),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("does not resend when the login fails", async () => {
    const screen = await render(
      <AuthFailureNotice
        threadId={threadId}
        failure={failure}
        providerLabel="Codex"
        driver="codex"
        error="401 Unauthorized"
        onDismiss={() => {}}
      />,
    );
    try {
      await page.getByRole("button", { name: "Sign in again" }).click();
      await vi.waitFor(() => expect(mocks.loginStart).toHaveBeenCalled());
      mocks.listener?.({ handle: "login-1", instanceId, type: "exited", data: "1" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mocks.resend).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("offers a plain Resend after signing in while the thread was busy", async () => {
    mocks.resend.mockResolvedValueOnce({ kind: "busy", reason: "The thread is busy." });
    const screen = await render(
      <AuthFailureNotice
        threadId={threadId}
        failure={failure}
        providerLabel="Claude"
        driver="claudeAgent"
        error="Claude login expired"
        onDismiss={() => {}}
      />,
    );
    try {
      await page.getByRole("button", { name: "Sign in again" }).click();
      await vi.waitFor(() => expect(mocks.loginStart).toHaveBeenCalledTimes(1));
      mocks.listener?.({ handle: "login-1", instanceId, type: "exited", data: "0" });
      const resendButton = page.getByRole("button", { name: "Resend", exact: true });
      await expect.element(resendButton).toBeVisible();
      await resendButton.click();
      await vi.waitFor(() => expect(mocks.resend).toHaveBeenCalledTimes(2));
      // Retrying never needed a second CLI login.
      expect(mocks.loginStart).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("cancels its running login when the dialog closes mid-sign-in", async () => {
    const cancel = mocks.cancel;
    cancel.mockClear();
    const screen = await render(
      <AuthFailureNotice
        threadId={threadId}
        failure={failure}
        providerLabel="Codex"
        driver="codex"
        error="401 Unauthorized"
        onDismiss={() => {}}
      />,
    );
    try {
      await page.getByRole("button", { name: "Sign in again" }).click();
      await vi.waitFor(() => expect(mocks.loginStart).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith({ handle: "login-1" }));
    } finally {
      await screen.unmount();
    }
  });
});
