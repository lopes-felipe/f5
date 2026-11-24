import { execFile } from "node:child_process";
import { app, BrowserWindow, dialog, webContents as electronWebContents } from "electron";
import type { IpcMainInvokeEvent, Session, WebContents, WebFrameMain } from "electron";
import type { PasskeyBackend, PasskeyCeremonyContext } from "./PasskeyBackend";
import { macPasskeyBackend } from "./PasskeyBackendMac";
import type { PasskeyCeremonyResult } from "./PasskeyBridge";
import {
  PASSKEY_CREATE_CHANNEL,
  PASSKEY_GET_CHANNEL,
  PASSKEY_ENABLE_CHANNEL,
  PASSKEY_STATUS_CHANNEL,
} from "./GuestProtocol";
import {
  resolveWebAuthnEntitlements,
  type WebAuthnEntitlements,
} from "@t3tools/shared/macWebAuthn";
export { resolveWebAuthnEntitlements } from "@t3tools/shared/macWebAuthn";

function command(executable: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      { timeout: 5000, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout) =>
        error ? reject(new Error("Could not read signed passkey entitlements.")) : resolve(stdout),
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}

export async function signedWebAuthnEntitlements(): Promise<WebAuthnEntitlements> {
  if (process.platform !== "darwin" || !app.isPackaged) return { browserPasskeys: false };
  try {
    const plist = await command("/usr/bin/codesign", [
      "-d",
      "--entitlements",
      ":-",
      process.execPath,
    ]);
    const json = await command("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], plist);
    return resolveWebAuthnEntitlements(JSON.parse(json));
  } catch {
    return { browserPasskeys: false };
  }
}

const notAllowed: PasskeyCeremonyResult = { success: false, error: "NotAllowedError" };
const ownerWindow = (frame: WebFrameMain | null) => {
  const contents = frame ? electronWebContents.fromFrame(frame) : undefined;
  const owner = contents?.hostWebContents ?? contents;
  return owner ? BrowserWindow.fromWebContents(owner) : null;
};
const chooseAccount = async (details: Electron.SelectWebauthnAccountDetails) => {
  if (details.accounts.length === 1) return details.accounts[0]?.credentialId;
  const options: Electron.MessageBoxOptions = {
    type: "none",
    message: "Choose a passkey",
    detail: details.relyingPartyId,
    buttons: [
      ...details.accounts.map((account) =>
        account.displayName && account.name && account.displayName !== account.name
          ? account.displayName + " (" + account.name + ")"
          : (account.name ?? account.displayName ?? "Unnamed passkey"),
      ),
      "Cancel",
    ],
    cancelId: details.accounts.length,
    defaultId: 0,
    noLink: true,
  };
  const parent = ownerWindow(details.frame);
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return details.accounts[response]?.credentialId;
};
const withDeadline = (ceremony: Promise<PasskeyCeremonyResult>, milliseconds: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    ceremony,
    new Promise<PasskeyCeremonyResult>((resolve) => {
      timer = setTimeout(() => resolve(notAllowed), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
};
const ceremonyDeadline = (timeout: unknown) =>
  (typeof timeout === "number" && timeout > 0 ? Math.min(timeout, 60 * 60_000) : 10 * 60_000) +
  5000;
const isTrustworthyOrigin = (origin: string) => {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    );
  } catch {
    return false;
  }
};

export function createPreviewPasskeys(
  entitlements: WebAuthnEntitlements,
  backend: PasskeyBackend | undefined = process.platform === "darwin"
    ? macPasskeyBackend
    : undefined,
  disabled = process.env.F5_DISABLE_PREVIEW_PASSKEYS === "1",
) {
  const allowed: WebAuthnEntitlements = disabled ? { browserPasskeys: false } : entitlements;
  const activeBackend = allowed.browserPasskeys ? backend : undefined;
  const installed = new WeakSet<Session>();
  return {
    bridgeEnabled: activeBackend !== undefined,
    configure: () => {
      if (allowed.touchIdKeychainAccessGroup)
        app.configureWebAuthn({
          touchID: { keychainAccessGroup: allowed.touchIdKeychainAccessGroup },
        });
    },
    installSessionHandlers: (session: Session) => {
      if ((!activeBackend && !allowed.touchIdKeychainAccessGroup) || installed.has(session)) return;
      installed.add(session);
      session.on("select-webauthn-account", (_event, details, callback) => {
        void chooseAccount(details).then(
          (credentialId) => callback(credentialId),
          () => callback(),
        );
      });
    },
    attachGuest: (guest: WebContents) => {
      if (activeBackend === undefined) return () => {};
      let ceremonyPending = false;
      let documentGeneration = 0;
      let detached = false;
      const onNavigation = (
        details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
      ) => {
        if (details.isMainFrame && !details.isSameDocument) documentGeneration++;
      };
      guest.on("did-start-navigation", onNavigation);
      const serve = async (
        event: IpcMainInvokeEvent,
        publicKey: { readonly timeout?: unknown } | undefined,
        ceremony: (context: PasskeyCeremonyContext) => Promise<PasskeyCeremonyResult>,
      ): Promise<PasskeyCeremonyResult> => {
        // Only the guest's main frame runs the bridge preload.
        const frame = event.senderFrame;
        if (!frame || frame !== guest.mainFrame) return notAllowed;
        // Page-supplied options cannot establish the caller's origin.
        // Read the committed origin before any await:
        // the frame object outlives a navigation.
        const origin = frame.origin;
        const generation = documentGeneration;
        // Like Chromium, only a focused page may open the sheet, one at a time.
        if (detached || !isTrustworthyOrigin(origin) || ceremonyPending || !guest.isFocused()) {
          return notAllowed;
        }
        if (typeof publicKey !== "object" || publicKey === null) {
          return { success: false, error: "TypeError" };
        }
        const host = guest.hostWebContents
          ? BrowserWindow.fromWebContents(guest.hostWebContents)
          : BrowserWindow.fromWebContents(guest);
        if (!host || host.isDestroyed()) return notAllowed;

        ceremonyPending = true;
        // Retain the gate until the native sheet settles, even when the caller's
        // deadline expires first. A timed-out sheet must not overlap another one.
        const operation = Promise.resolve()
          .then(() => ceremony({ origin, nativeWindowHandle: host.getNativeWindowHandle() }))
          .finally(() => {
            ceremonyPending = false;
          });
        try {
          const result = await withDeadline(operation, ceremonyDeadline(publicKey.timeout));
          // A credential minted for a document that navigated away belongs to nobody.
          const sameDocument =
            !detached &&
            generation === documentGeneration &&
            !frame.isDestroyed() &&
            frame === guest.mainFrame &&
            frame.origin === origin;
          return sameDocument ? result : notAllowed;
        } catch {
          return notAllowed;
        }
      };
      const removeHandlers = () => {
        guest.ipc.removeHandler(PASSKEY_CREATE_CHANNEL);
        guest.ipc.removeHandler(PASSKEY_GET_CHANNEL);
        guest.ipc.removeHandler(PASSKEY_STATUS_CHANNEL);
      };
      removeHandlers();
      guest.ipc.handle(
        PASSKEY_STATUS_CHANNEL,
        (event) => !detached && !guest.isDestroyed() && event.senderFrame === guest.mainFrame,
      );
      // Option shapes are the page's to get wrong: the native layer validates
      // them and answers with a TypeError.
      guest.ipc.handle(
        PASSKEY_CREATE_CHANNEL,
        (event, publicKey: PublicKeyCredentialCreationOptions) =>
          serve(event, publicKey, (context) => activeBackend.create(publicKey, context)),
      );
      guest.ipc.handle(PASSKEY_GET_CHANNEL, (event, publicKey: PublicKeyCredentialRequestOptions) =>
        serve(event, publicKey, (context) => activeBackend.get(publicKey, context)),
      );
      const enable = () => {
        if (!detached && !guest.isDestroyed()) guest.send(PASSKEY_ENABLE_CHANNEL);
      };
      guest.on("dom-ready", enable);
      enable();
      return () => {
        detached = true;
        guest.removeListener("did-start-navigation", onNavigation);
        guest.removeListener("dom-ready", enable);
        removeHandlers();
      };
    },
  };
}
