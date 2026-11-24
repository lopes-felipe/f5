import { showBootError } from "./lib/bootError";
import "./index.css";

void import("./main").then(() => {
  const shell = document.getElementById("boot-shell");
  if (shell && !document.getElementById("boot-error")) shell.hidden = true;
}, showBootError);
