import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";

// Deliberately independent of React, the router and application state.
export async function resolveDebugCommand(
  bridge: DesktopBridge | undefined,
): Promise<string | null> {
  try {
    const state = await bridge?.cliCommand?.state();
    const installed = state?.installedPaths.f5;
    if (installed) return state.onPath ? "f5" : "'" + installed.replaceAll("'", "'\"'\"'") + "'";
  } catch {
    // Broken IPC must not hide recovery actions.
  }
  return null;
}

export function buildBootErrorReport(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  for (let current = error; current != null && !seen.has(current) && parts.length < 4; ) {
    seen.add(current);
    try {
      parts.push(current instanceof Error ? (current.stack ?? current.message) : String(current));
    } catch {
      parts.push("(error could not be described)");
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return (
    parts
      .join("\nCaused by: ")
      .replace(/\b[a-z][\w+.-]*:\/\/[^\s/?#)'"]+/gi, "")
      .replace(/[?#][^\s)'"]+/g, "")
      .slice(0, 6000) +
    "\n\nF5 " +
    import.meta.env.APP_VERSION +
    "\n" +
    navigator.userAgent
  );
}

export function showBootError(error: unknown): void {
  console.error("F5 failed to start.", error);
  const shell = document.getElementById("boot-shell");
  if (!shell) return;
  shell.hidden = false;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  };
  const content = make("section");
  content.id = "boot-error";
  const heading = make("div");
  heading.setAttribute("role", "alert");
  heading.append(
    make("h1", "F5 failed to start"),
    make(
      "p",
      navigator.onLine === false
        ? "This browser appears to be offline. Check your connection, then reload."
        : "Try reloading. If it keeps failing, use the recovery options below.",
    ),
  );
  content.append(heading);
  const actions = make("div");
  const button = (text: string, action: () => void) => {
    const node = make("button", text);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  };
  actions.append(button("Reload", () => window.location.reload()));
  const status = make("p");
  status.setAttribute("aria-live", "polite");
  const bridge = window.desktopBridge;
  if (bridge) {
    let state: DesktopUpdateState | undefined;
    const update = button("Download update", () => {
      const run =
        state?.status === "downloaded"
          ? bridge.installUpdate()
          : state?.status === "available"
            ? bridge.downloadUpdate()
            : undefined;
      void run?.then(
        (result) => renderUpdate(result.state),
        () => {
          status.textContent = "Update failed. Try again.";
        },
      );
    });
    function renderUpdate(next: DesktopUpdateState) {
      state = next;
      update.hidden = !["available", "downloading", "downloaded"].includes(next.status);
      update.disabled = next.status === "downloading";
      update.textContent =
        next.status === "downloaded"
          ? "Restart to update"
          : next.status === "downloading"
            ? "Downloading update…"
            : "Download update";
    }
    update.hidden = true;
    actions.append(update);
    try {
      let pushed = false;
      bridge.onUpdateState((next) => {
        pushed = true;
        renderUpdate(next);
      });
      void bridge.getUpdateState().then(
        (next) => {
          if (!pushed) renderUpdate(next);
        },
        () => {},
      );
    } catch {
      update.hidden = true;
    }
  }
  content.append(actions);
  const more = make("details");
  try {
    const previous = Number(sessionStorage.getItem("f5:boot-failed-at"));
    more.open = previous > 0 && Date.now() - previous < 300_000;
    sessionStorage.setItem("f5:boot-failed-at", String(Date.now()));
  } catch {
    /* Storage can be disabled. */
  }
  more.append(make("summary", "More options if it keeps failing"));
  more.append(
    make(
      "p",
      "Ask your agent to inspect the local server logs on the computer hosting F5. If a terminal command is installed, run it there to inspect startup output.",
    ),
  );
  const command = make("code");
  const copy = (target: HTMLElement) => {
    const fallback = () => {
      const range = document.createRange();
      range.selectNodeContents(target);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      status.textContent = "Text selected. Press Ctrl+C or ⌘C to copy.";
    };
    if (!navigator.clipboard?.writeText) return fallback();
    void navigator.clipboard.writeText(target.textContent ?? "").then(() => {
      status.textContent = "Copied";
    }, fallback);
  };
  const commandRow = make("div");
  commandRow.hidden = true;
  commandRow.append(
    command,
    button("Copy command", () => copy(command)),
  );
  void resolveDebugCommand(bridge).then((value) => {
    if (value) {
      command.textContent = value;
      commandRow.hidden = false;
    }
  });
  more.append(commandRow);
  const report = make("pre", buildBootErrorReport(error));
  report.tabIndex = 0;
  more.append(
    report,
    make("p", "Details may contain local paths and names. Check before sharing."),
    button("Copy error details", () => copy(report)),
  );
  const issue = make("a", "Report a startup crash");
  issue.href = "https://github.com/lopes-felipe/f5/issues/new";
  issue.target = "_blank";
  issue.rel = "noreferrer";
  more.append(issue);
  if (bridge) {
    const download = make("a", "Download and reinstall F5");
    download.href = "https://github.com/lopes-felipe/f5/releases";
    download.target = "_blank";
    download.rel = "noreferrer";
    more.append(download);
  }
  content.append(more, status);
  shell.replaceChildren(content);
}
