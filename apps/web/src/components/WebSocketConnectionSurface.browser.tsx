import {
  useComposerDraftStore,
  resetComposerDraftBaseStorageForTesting,
  setComposerDraftBaseStorageForTesting,
  serializeComposerDraftRecovery,
} from "../composerDraftStore";
import { serverBootstrapFixture } from "../test/serverBootstrap";
import { F5_PROTOCOL_VERSION, ThreadId } from "@t3tools/contracts";
import {
  beginProtocolUpload,
  requireProtocolUpgrade,
  resetProtocolStateForTests,
  reloadForProtocolUpgrade,
  setServerBootstrap,
} from "../protocolState";
import "../index.css";

import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  noteWsSynchronizationError,
  registerWsTransportReconnectHandler,
  resetWsConnectionStateForTests,
} from "../wsConnectionState";
import { WEB_LOCAL_FLAG_KEYS } from "../webLocalFlags";
import { mountConnectionSurface as mountSurface } from "../test/connectionSurface";

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

describe("WebSocketConnectionSurface", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    sessionStorage.clear();
    resetComposerDraftBaseStorageForTesting();
    useComposerDraftStore.setState({ draftsByThreadId: {}, imageImportsByThreadId: {} });
    document.body.innerHTML = "";
    resetRequestLatencyStateForTests();
    resetWsConnectionStateForTests();
    resetProtocolStateForTests();
    vi.mocked(reloadForProtocolUpgrade).mockClear();
  });

  afterEach(() => {
    resetComposerDraftBaseStorageForTesting();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("offers reload after repeated synchronization failures and preserves editable drafts", async () => {
    noteWsConnectionOpened();
    const mounted = await mountSurface(
      <textarea aria-label="draft" defaultValue="keep this draft" />,
    );
    try {
      const draft = mounted.host.querySelector("textarea")!;
      noteWsSynchronizationError("Synchronization failed repeatedly. Reload the app to recover.");
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain("Reload the app to recover"),
      );
      expect(document.body.textContent).toContain("Reload app");
      expect(mounted.host.querySelector("textarea")).toBe(draft);
      expect(draft.value).toBe("keep this draft");
      expect(draft.closest("[inert]")).toBeNull();
      draft.focus();
      expect(document.activeElement).toBe(draft);
    } finally {
      await mounted.cleanup();
    }
  });

  it("guards breaker reload while an upload is active", async () => {
    const finishUpload = beginProtocolUpload();
    noteWsSynchronizationError("Reload the app to recover.");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const mounted = await mountSurface(<textarea defaultValue="keep draft" />);
    try {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Reload app"))!
        .click();
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Uploads will be interrupted"));
      expect(mounted.host.querySelector("textarea")!.value).toBe("keep draft");
    } finally {
      finishUpload();
      await mounted.cleanup();
    }
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
      expect(document.body.textContent).toContain("Reload anyway");
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Reload anyway"))
        ?.click();
      expect(confirm).toHaveBeenCalledWith(
        expect.stringContaining("unsaved draft attachments will be lost"),
      );

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

  it.each(["upgrade", "synchronization"])(
    "keeps importing and unsaved images recoverable during %s failure",
    async (kind) => {
      setServerBootstrap(serverBootstrapFixture);
      const threadId = ThreadId.makeUnsafe("upgrade-draft");
      const file = new File(["clipboard image"], "clipboard.png", { type: "image/png" });
      let finish!: () => void;
      const wait = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const importing = useComposerDraftStore.getState().importImages(threadId, [file], {
        processor: async () => {
          await wait;
          return {
            ok: true,
            file,
            recompressed: false,
            originalSizeBytes: file.size,
            finalSizeBytes: file.size,
          };
        },
      });
      const mounted = await mountSurface();
      try {
        if (kind === "upgrade") requireProtocolUpgrade();
        else noteWsSynchronizationError("Reload the app to recover.");
        const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
        const clickReload = () =>
          Array.from(document.querySelectorAll("button"))
            .find((button) =>
              button.textContent?.includes(kind === "upgrade" ? "Reload anyway" : "Reload app"),
            )!
            .click();
        await vi.waitFor(() =>
          expect(document.body.textContent).toContain(
            kind === "upgrade" ? "Reload anyway" : "Reload app",
          ),
        );
        clickReload();
        expect(confirm).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(reloadForProtocolUpgrade).not.toHaveBeenCalled();
        finish();
        await importing;
        await vi.advanceTimersByTimeAsync(1000);
        expect(reloadForProtocolUpgrade).not.toHaveBeenCalled();
        const recovery = JSON.parse(await serializeComposerDraftRecovery());
        expect(recovery.drafts[0].attachments[0].dataUrl).toBe(
          "data:image/png;base64,Y2xpcGJvYXJkIGltYWdl",
        );
        setComposerDraftBaseStorageForTesting({
          getItem: () => null,
          setItem: () => {
            throw new Error("quota exceeded");
          },
          removeItem: () => {},
        });
        useComposerDraftStore
          .getState()
          .syncPersistedAttachments(threadId, recovery.drafts[0].attachments);
        await vi.advanceTimersByTimeAsync(1000);
        expect(reloadForProtocolUpgrade).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain("Download drafts");
        confirm.mockClear();
        clickReload();
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(
          useComposerDraftStore.getState().draftsByThreadId[threadId]?.nonPersistedImageIds,
        ).toHaveLength(1);
        resetComposerDraftBaseStorageForTesting();
        useComposerDraftStore
          .getState()
          .syncPersistedAttachments(threadId, recovery.drafts[0].attachments);
        if (kind === "upgrade") {
          await vi.waitFor(() => expect(document.body.textContent).toContain("Reloading"));
          await vi.advanceTimersByTimeAsync(300);
          expect(reloadForProtocolUpgrade).toHaveBeenCalledTimes(1);
        } else expect(reloadForProtocolUpgrade).not.toHaveBeenCalled();
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("offers manual recovery when this version has already attempted a reload", async () => {
    sessionStorage.setItem(`f5:protocol-reload:${F5_PROTOCOL_VERSION}`, "attempted");
    requireProtocolUpgrade();
    const mounted = await mountSurface();
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(reloadForProtocolUpgrade).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("Automatic reload already attempted");
      expect(document.body.textContent).toContain("Reload anyway");
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
        expect(document.body.textContent).not.toContain("Connection lost.");
      });

      noteWsConnectionOpened();

      await vi.waitFor(() => {
        expect(document.body.textContent).not.toContain("Connection lost.");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps local reading and drafting interactive while disconnected", async () => {
    enableFlag(WEB_LOCAL_FLAG_KEYS.wsDisconnectSurfaceEnabled);
    noteWsConnectionAttempt();
    noteWsConnectionOpened();
    noteWsConnectionClosed();

    const mounted = await mountSurface(<div>Persistent child</div>);
    try {
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Reconnecting…");
        expect(document.body.textContent).toContain("Persistent child");
      });

      resetWsConnectionStateForTests();
      resetProtocolStateForTests();
      vi.mocked(reloadForProtocolUpgrade).mockClear();
      noteWsConnectionAttempt();
      noteWsConnectionClosed();

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Connection lost.");
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
        expect(document.body.textContent).not.toContain("Connection lost.");
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
