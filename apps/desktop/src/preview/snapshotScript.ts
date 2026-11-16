import type { PreviewAutomationSnapshot } from "@t3tools/contracts";
import { previewSecretCollectionSource, redactPreviewSnapshot } from "./snapshotSecrets";
import { makePreviewSnapshotSecretReader, previewSnapshotChanged } from "./snapshotFrameSecrets";

export function buildPreviewAutomationSnapshotScript(
  diagnostics: Pick<
    PreviewAutomationSnapshot,
    "consoleEntries" | "networkEntries" | "actionTimeline"
  > = {
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: [],
  },
  options: { readonly truncateVisibleText?: boolean } = {},
): string {
  return String.raw`
(() => {
  ${previewSecretCollectionSource}
  const redact = ${redactPreviewSnapshot.toString()};
  const selectorFor = (element) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return "";
    if (element.id) return "#" + CSS.escape(element.id);
    for (const attribute of ["data-testid", "name", "aria-label"]) {
      const value = element.getAttribute(attribute);
      if (value) return element.tagName.toLowerCase() + "[" + attribute + "=" + JSON.stringify(value) + "]";
    }
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      const parent = current.parentElement;
      const siblings = parent
        ? Array.from(parent.children).filter((child) => child.tagName === current.tagName)
        : [];
      const base = current.tagName.toLowerCase();
      parts.unshift(siblings.length > 1 ? base + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")" : base);
      current = parent;
    }
    return parts.join(" > ");
  };
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const elements = Array.from(document.querySelectorAll("a[href],button,input,textarea,select,[role],[tabindex],[contenteditable='true']"))
    .filter(visible)
    .slice(0, 80)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        name: element.getAttribute("aria-label") || element.getAttribute("name") || element.innerText || element.textContent || element.value || "",
        selector: selectorFor(element),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      };
    });
  const snapshot = redact({
    url: location.href,
    title: document.title,
    loading: document.readyState !== "complete",
    // Keep enough lookahead for the longest supported serialized credential
    // crossing the final text boundary; never transfer an unbounded page body.
    visibleText: (document.body?.innerText || "").slice(0, 20_000 + 6 * 16_384),
    interactiveElements: elements,
    accessibilityTree: null,
    consoleEntries: ${JSON.stringify(diagnostics.consoleEntries)},
    networkEntries: ${JSON.stringify(diagnostics.networkEntries)},
    actionTimeline: ${JSON.stringify(diagnostics.actionTimeline)}
  }, [...sensitive]);
  ${options.truncateVisibleText === false ? "" : "snapshot.visibleText = snapshot.visibleText.slice(0, 20_000);"}
  return snapshot;
})()
`;
}

/** Capture in an isolated world so page code cannot redefine field-value getters. */
const pendingSnapshots = new WeakSet<object>();

export async function capturePreviewSnapshotPage(
  guest: Pick<
    Electron.WebContents,
    "mainFrame" | "debugger" | "executeJavaScriptInIsolatedWorld" | "on" | "removeListener"
  >,
  diagnostics: Pick<
    PreviewAutomationSnapshot,
    "consoleEntries" | "networkEntries" | "actionTimeline"
  >,
): Promise<Omit<PreviewAutomationSnapshot, "screenshot">> {
  if (pendingSnapshots.has(guest))
    throw new Error("A previous snapshot is still finishing. Try again when the page settles.");
  pendingSnapshots.add(guest);
  let navigated = false;
  let active = true;
  let rejectNavigation!: () => void;
  const navigationFailed = new Promise<never>((_, reject) => {
    rejectNavigation = () => reject(previewSnapshotChanged());
  });
  const navigation = () => {
    navigated = true;
    rejectNavigation();
  };
  guest.on("did-start-navigation", navigation);
  const check = () => {
    if (!active || navigated) throw previewSnapshotChanged();
  };
  const reader = makePreviewSnapshotSecretReader(guest, check);
  const capture = (async () => {
    const observed = new Set<string>();
    let observedCharacters = 0;
    const remember = (read: ReadonlyArray<ReadonlyArray<string>>) => {
      for (const entries of read)
        for (const value of entries) {
          if (observed.has(value)) continue;
          if (observed.size >= 4096 || observedCharacters + value.length > 1_048_576)
            throw previewSnapshotChanged();
          observed.add(value);
          observedCharacters += value.length;
        }
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await reader.read();
      remember(before);
      const raw = (await guest.executeJavaScriptInIsolatedWorld(1007, [
        { code: buildPreviewAutomationSnapshotScript(diagnostics, { truncateVisibleText: false }) },
      ])) as Omit<PreviewAutomationSnapshot, "screenshot">;
      check();
      const after = await reader.read();
      remember(after);
      if (JSON.stringify(before) !== JSON.stringify(after)) continue;
      const result = redactPreviewSnapshot(raw, [...observed]);
      return { ...result, visibleText: result.visibleText.slice(0, 20_000) };
    }
    throw previewSnapshotChanged();
  })().catch(() => {
    throw previewSnapshotChanged();
  });
  // A deadline cannot cancel an outstanding renderer command. Keep one slot
  // occupied until it answers, so repeated requests cannot accumulate behind it.
  void capture.then(
    () => pendingSnapshots.delete(guest),
    () => pendingSnapshots.delete(guest),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      capture,
      navigationFailed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Preview snapshot timed out. Try again when the page settles.")),
          10_000,
        );
      }),
    ]);
    check();
    return snapshot;
  } finally {
    active = false;
    reader.close();
    clearTimeout(timer);
    guest.removeListener("did-start-navigation", navigation);
  }
}
