import { contextBridge, ipcRenderer } from "electron";
import {
  PASSKEY_BRIDGE_ARGUMENT,
  PASSKEY_CREATE_CHANNEL,
  PASSKEY_GET_CHANNEL,
} from "./GuestProtocol";
import { installPasskeyBridge } from "./PasskeyBridge";

if (process.argv.includes(PASSKEY_BRIDGE_ARGUMENT)) {
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
}
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
