import { ipcRenderer } from "electron";
// No bridge, Node API, arbitrary arguments, or app API is exposed to guest pages.
window.addEventListener(
  "mouseup",
  (event) => {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    ipcRenderer.send("preview:mouse-navigate", event.button === 3 ? "back" : "forward");
  },
  true,
);
