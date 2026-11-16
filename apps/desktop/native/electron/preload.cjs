const { ipcRenderer } = require("electron");
window.addEventListener("DOMContentLoaded", () => {
  const field = document.getElementById("input");
  const press = document.getElementById("press");
  const counter = document.getElementById("counter");
  let presses = 0;
  press.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    counter.textContent = "presses: " + ++presses;
    ipcRenderer.send("fixture-observation", "press");
  });
  field.addEventListener("input", (event) => {
    if (event.isTrusted && field.value === "F5_ELECTRON_REHEARSAL Ω🙂")
      ipcRenderer.send("fixture-observation", "typed");
  });
  document.getElementById("focus-secure").addEventListener("click", (event) => {
    if (event.isTrusted) document.getElementById("secure").focus();
  });
  field.focus();
  ipcRenderer.send("fixture-observation", "ready");
});
