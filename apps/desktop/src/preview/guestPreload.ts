import { contextBridge, ipcRenderer } from "electron";
import {
  PASSKEY_BRIDGE_ARGUMENT,
  PASSKEY_CREATE_CHANNEL,
  PASSKEY_GET_CHANNEL,
  PASSKEY_ENABLE_CHANNEL,
  PASSKEY_STATUS_CHANNEL,
} from "./GuestProtocol";
import { installPasskeyBridge } from "./PasskeyBridge";

let passkeysInstalled = false;
function enablePasskeys() {
  if (passkeysInstalled) return;
  // Only these two ceremonies cross the isolated world. The main process
  // validates the actual guest frame and origin, not these untrusted inputs.
  contextBridge.exposeInMainWorld("__f5Passkeys", {
    invoke: (channel: string, publicKey: unknown) => {
      if (channel !== PASSKEY_CREATE_CHANNEL && channel !== PASSKEY_GET_CHANNEL)
        return Promise.reject(new Error("Unsupported passkey operation."));
      return ipcRenderer.invoke(channel, publicKey);
    },
  });
  contextBridge.executeInMainWorld({ func: installPasskeyBridge, args: [] });
  passkeysInstalled = true;
}
// A notice alone grants nothing: confirm through the entitled guest's handler.
// The embedder can send webview messages too, so it cannot authorize the bridge.
ipcRenderer.on(PASSKEY_ENABLE_CHANNEL, () => {
  if (passkeysInstalled) return;
  void ipcRenderer
    .invoke(PASSKEY_STATUS_CHANNEL)
    .then((enabled) => {
      if (enabled === true) enablePasskeys();
    })
    .catch(() => undefined);
});
if (process.argv.includes(PASSKEY_BRIDGE_ARGUMENT)) enablePasskeys();
// No Node API or general app API is exposed to guest pages.
window.addEventListener(
  "mouseup",
  (event) => {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    ipcRenderer.send("preview:mouse-navigate", event.button === 3 ? "back" : "forward");
  },
  true,
);
