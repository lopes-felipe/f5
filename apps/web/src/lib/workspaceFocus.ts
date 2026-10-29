import { dismissContextMenuFallback } from "../contextMenuFallback";

const AREA_SELECTOR = "[data-workspace-area]";
const FOCUS_BOUNDARY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], [data-slot$="-popup"]:not([data-slot="tooltip-popup"]):not([role="tooltip"])';
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [contenteditable="true"], [tabindex]';
const PREFERRED_SELECTOR =
  '[data-workspace-focus-default], [role="treeitem"][tabindex="0"], .xterm-helper-textarea, [contenteditable="true"]';

/** Props that make an element one stop in the F6 cycle; `order` sets its place in the cycle. */
export function workspaceAreaProps(name: string, order: number, label: string) {
  return {
    "data-workspace-area": name,
    "data-workspace-order": order,
    "aria-label": label,
    role: "region",
    tabIndex: -1,
  } as const;
}

function workspaceArea(element: Element): HTMLElement | null {
  const area = element.closest<HTMLElement>(AREA_SELECTOR);
  if (area) return area;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? workspaceArea(root.host) : null;
}

export function isWorkspaceElementVisible(element: HTMLElement): boolean {
  if (
    !element.isConnected ||
    element.closest(
      '[hidden], [inert], [data-closed], [aria-hidden="true"], [data-slot="sidebar"][data-state="collapsed"], [data-workspace-unavailable="true"]',
    )
  )
    return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const root = element.getRootNode();
  if (
    root instanceof ShadowRoot &&
    root.host instanceof HTMLElement &&
    !isWorkspaceElementVisible(root.host)
  )
    return false;
  return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
}

function scrollingAncestors(target: HTMLElement) {
  const scrollers: HTMLElement[] = [];
  for (let element = target.parentElement; element; element = element.parentElement) {
    const { overflowY } = getComputedStyle(element);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      element.scrollHeight > element.clientHeight
    )
      scrollers.push(element);
  }
  return scrollers;
}

function isInScrollView(target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  return scrollingAncestors(target).every((scroller) => {
    const box = scroller.getBoundingClientRect();
    return rect.bottom > box.top && rect.top < box.bottom;
  });
}

/**
 * Brings a restored control into view, innermost scrolling list first.
 * scrollIntoView would also scroll overflow-hidden layout containers out of place.
 */
function revealInScrollers(target: HTMLElement) {
  for (const scroller of scrollingAncestors(target)) {
    const box = scroller.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    if (rect.top < box.top) scroller.scrollTop -= box.top - rect.top;
    else if (rect.bottom > box.bottom) scroller.scrollTop += rect.bottom - box.bottom;
  }
}

/**
 * F6 area focus, like VS Code's layout focusPart: each area remembers its last focused
 * control, and moving into an area returns there, else to its preferred control.
 */
export function createWorkspaceFocusController(doc: Document) {
  const lastFocused = new Map<string, HTMLElement>();
  let lastArea: string | undefined;
  const remember = (event: FocusEvent) => {
    if (!(event.target instanceof HTMLElement)) return;
    const area = workspaceArea(event.target);
    if (!area?.dataset.workspaceArea) return;
    lastArea = area.dataset.workspaceArea;
    const key = area.dataset.workspaceFocusKey ?? lastArea;
    // Custom file trees retarget focusin to their nonfocusable shadow host.
    const target = event.composedPath().find((element) => element instanceof HTMLElement);
    lastFocused.delete(key);
    lastFocused.set(key, target instanceof HTMLElement ? target : event.target);
    // Surface history must not retain an unbounded number of detached panel trees.
    if (lastFocused.size > 64) lastFocused.delete(lastFocused.keys().next().value!);
  };
  doc.addEventListener("focusin", remember);

  const focusArea = (area: HTMLElement) => {
    const key = area.dataset.workspaceFocusKey ?? area.dataset.workspaceArea!;
    const previous = lastFocused.get(key);
    const belongs = (element: HTMLElement) =>
      workspaceArea(element) === area &&
      isWorkspaceElementVisible(element) &&
      !element.matches(":disabled");
    const preferred = Array.from(area.querySelectorAll<HTMLElement>(PREFERRED_SELECTOR)).find(
      belongs,
    );
    const fallback = Array.from(area.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).find(
      (element) => element.tabIndex >= 0 && belongs(element),
    );
    // Moving the timeline to an old control would also stop it following a running turn,
    // so the conversation reuses a control only while it is still in view.
    const isConversation = area.dataset.workspaceArea === "conversation";
    const targets = new Set([
      previous && belongs(previous) && (!isConversation || isInScrollView(previous))
        ? previous
        : undefined,
      preferred,
      isConversation ? undefined : fallback,
      area,
    ]);
    for (const target of targets) {
      if (!target) continue;
      target.focus({ preventScroll: true });
      const root = target.getRootNode();
      const active = root instanceof ShadowRoot ? root.activeElement : doc.activeElement;
      if (active === target || (active && target.contains(active))) {
        if (target !== area && !isConversation) revealInScrollers(target);
        return true;
      }
    }
    return false;
  };

  const move = (direction: 1 | -1, fromArea?: string) => {
    // A renderer context menu closes like a blur; modal dialogs and popups keep focus.
    dismissContextMenuFallback(false);
    const activePopup = doc.activeElement?.closest<HTMLElement>('[role="menu"], [role="listbox"]');
    const boundaries = Array.from(doc.querySelectorAll<HTMLElement>(FOCUS_BOUNDARY_SELECTOR));
    // Inline listboxes belong to their area; portalled ones are a boundary of their own.
    if (activePopup && !activePopup.closest(AREA_SELECTOR)) boundaries.push(activePopup);
    // A modal keeps focus wherever it is; any other popup only while it holds focus,
    // so hover popups and notifications never swallow the key.
    if (
      boundaries.some(
        (boundary) =>
          (boundary.matches('[aria-modal="true"]') || boundary.contains(doc.activeElement)) &&
          isWorkspaceElementVisible(boundary),
      )
    )
      return false;
    const areas = Array.from(doc.querySelectorAll<HTMLElement>(AREA_SELECTOR))
      .filter(isWorkspaceElementVisible)
      .sort(
        (left, right) => Number(left.dataset.workspaceOrder) - Number(right.dataset.workspaceOrder),
      );
    if (areas.length === 0) return false;
    const activeArea = doc.activeElement ? workspaceArea(doc.activeElement) : null;
    const currentId = fromArea ?? activeArea?.dataset.workspaceArea ?? lastArea;
    const current = areas.findIndex((area) => area.dataset.workspaceArea === currentId);
    const index =
      current === -1
        ? direction === 1
          ? 0
          : areas.length - 1
        : (current + direction + areas.length) % areas.length;
    return focusArea(areas[index]!);
  };

  return {
    move,
    dispose: () => doc.removeEventListener("focusin", remember),
  };
}

let controller: ReturnType<typeof createWorkspaceFocusController> | undefined;

/** Starts F6 area focus for the app document; returns its cleanup. */
export function startWorkspaceFocus(doc: Document = document): () => void {
  const active = createWorkspaceFocusController(doc);
  controller = active;
  return () => {
    active.dispose();
    if (controller === active) controller = undefined;
  };
}

/** Moves to the next or previous visible area. `fromArea` overrides the focused area. */
export function moveWorkspaceFocus(direction: 1 | -1, fromArea?: string): boolean {
  return controller?.move(direction, fromArea) ?? false;
}
