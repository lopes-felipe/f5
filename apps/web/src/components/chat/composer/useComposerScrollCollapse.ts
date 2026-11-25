import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { shouldScrollTimeline } from "../timelineScrollTarget";

const EDITOR_SELECTOR = '[data-testid="composer-editor"]';
const THRESHOLD_PX = 24;
const GESTURE_IDLE_MS = 120;
const POPUP_SELECTOR =
  '[data-slot="menu-popup"], [data-slot="popover-popup"], [data-slot="combobox-popup"], [data-slot="select-popup"], [role="dialog"]';

/** A scroll gesture, not blur, puts an existing conversation's composer at rest.
 * Keep the editor and controls mounted: Lexical owns the selection and undo stack.
 * Expansion suppresses the current gesture's momentum until it has gone idle.
 */
export function useComposerScrollCollapse({
  enabled,
  threadId,
  blocked,
  formRef,
  getTimeline,
}: {
  enabled: boolean;
  threadId: string;
  blocked: boolean;
  formRef: RefObject<HTMLFormElement | null>;
  getTimeline: () => HTMLElement | null;
}) {
  const [collapsedThread, setCollapsedThread] = useState<string | null>(null);
  const gesture = useRef({ delta: 0, lastAt: -Infinity, suppressed: false });
  const collapsedRef = useRef(false);
  const composing = useRef(false);
  const refocusing = useRef(false);
  const collapsed = enabled && !blocked && collapsedThread === threadId;
  const expand = useCallback(() => {
    const current = gesture.current;
    if (performance.now() - current.lastAt <= GESTURE_IDLE_MS) current.suppressed = true;
    current.delta = 0;
    collapsedRef.current = false;
    setCollapsedThread(null);
  }, []);

  useEffect(() => {
    collapsedRef.current = false;
    setCollapsedThread(null);
    composing.current = false;
    gesture.current = { delta: 0, lastAt: -Infinity, suppressed: false };
  }, [threadId, enabled]);

  useEffect(() => {
    if (blocked && collapsedRef.current) expand();
  }, [blocked, expand]);

  // Marks the form while the editor height animates, so index.css can clip the
  // editor until it settles. Reading animations flushes style, so the marker is
  // in place before the transition's first frame paints.
  const syncResizing = useCallback(() => {
    const form = formRef.current;
    const editor = form?.querySelector(EDITOR_SELECTOR);
    form?.toggleAttribute(
      "data-composer-resizing",
      !!editor
        ?.getAnimations()
        .some(
          (animation) =>
            animation instanceof CSSTransition &&
            animation.transitionProperty === "height" &&
            animation.playState === "running",
        ),
    );
  }, [formRef]);

  useLayoutEffect(syncResizing, [collapsed, syncResizing]);

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const transition = (event: TransitionEvent) => {
      if (
        event.propertyName === "height" &&
        event.target instanceof Element &&
        event.target.matches(EDITOR_SELECTOR)
      )
        syncResizing();
    };
    form.addEventListener("transitionrun", transition);
    form.addEventListener("transitionend", transition);
    form.addEventListener("transitioncancel", transition);
    return () => {
      form.removeEventListener("transitionrun", transition);
      form.removeEventListener("transitionend", transition);
      form.removeEventListener("transitioncancel", transition);
      form.removeAttribute("data-composer-resizing");
    };
  }, [formRef, syncResizing]);

  useEffect(() => {
    if (!enabled) return;
    const form = formRef.current;
    let focusFrame = 0;
    const windowFocus = () => {
      refocusing.current = true;
      cancelAnimationFrame(focusFrame);
      focusFrame = requestAnimationFrame(() => {
        refocusing.current = false;
      });
    };
    const editorInteraction = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('[data-testid="composer-editor"], [data-composer-editor-area]'))
        expand();
    };
    const focus = (event: FocusEvent) => {
      if (!refocusing.current) editorInteraction(event);
    };
    const startComposition = () => {
      composing.current = true;
      expand();
    };
    const endComposition = () => {
      composing.current = false;
      expand();
    };
    const wheel = (event: WheelEvent) => {
      if (
        blocked ||
        composing.current ||
        event.ctrlKey ||
        event.defaultPrevented ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
        !(event.target instanceof Element)
      )
        return;
      const timeline = getTimeline();
      if (!timeline || !timeline.contains(event.target)) return;
      const now = performance.now();
      const current = gesture.current;
      if (now - current.lastAt > GESTURE_IDLE_MS) {
        current.delta = 0;
        current.suppressed = false;
      }
      current.lastAt = now;
      // Track momentum while resting, but avoid layout/style reads and popup scans.
      if (collapsedRef.current || current.suppressed) return;
      const selection = window.getSelection();
      const canScroll =
        event.deltaY < 0
          ? timeline.scrollTop > 1
          : timeline.scrollTop + timeline.clientHeight < timeline.scrollHeight - 1;
      if (
        !canScroll ||
        timeline.scrollHeight <= timeline.clientHeight + 1 ||
        Array.from(document.querySelectorAll<HTMLElement>(POPUP_SELECTOR)).some(
          (popup) => popup.getClientRects().length > 0,
        ) ||
        (selection && !selection.isCollapsed && !form?.contains(selection.anchorNode)) ||
        !shouldScrollTimeline(event.target, timeline, event.deltaY)
      ) {
        current.delta = 0;
        return;
      }
      current.delta +=
        Math.abs(event.deltaY) *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? timeline.clientHeight : 1);
      if (current.delta >= THRESHOLD_PX) {
        current.delta = 0;
        collapsedRef.current = true;
        setCollapsedThread(threadId);
      }
    };
    // The list may mount after the form, or lose content without resizing its
    // viewport (rewind). Observe its content as well as the containing column.
    let layoutFrame = 0;
    let observedTimeline: HTMLElement | null = null;
    let observedContent: Element | null = null;
    const checkLayout = () => {
      layoutFrame = 0;
      const timeline = getTimeline();
      if (timeline !== observedTimeline) {
        observer.disconnect();
        if (form) observer.observe(form);
        if (timeline) observer.observe(timeline);
        observedTimeline = timeline;
        observedContent = null;
      }
      const content = timeline?.firstElementChild ?? null;
      if (content !== observedContent) {
        if (observedContent) observer.unobserve(observedContent);
        if (content) observer.observe(content);
        observedContent = content;
      }
      if (collapsedRef.current && (!timeline || timeline.scrollHeight <= timeline.clientHeight + 1))
        expand();
    };
    const scheduleLayout = () => {
      if (!layoutFrame) layoutFrame = requestAnimationFrame(checkLayout);
    };
    const observer = new ResizeObserver(scheduleLayout);
    const mutations = new MutationObserver(scheduleLayout);
    const column = form?.closest("[data-composer-input-bar]")?.parentElement;
    if (column) mutations.observe(column, { childList: true, subtree: true });
    checkLayout();
    document.addEventListener("wheel", wheel, { capture: true, passive: true });
    window.addEventListener("focus", windowFocus);
    form?.addEventListener("pointerdown", editorInteraction, true);
    form?.addEventListener("focusin", focus);
    form?.addEventListener("beforeinput", expand);
    form?.addEventListener("keydown", editorInteraction, true);
    form?.addEventListener("paste", expand, true);
    form?.addEventListener("compositionstart", startComposition, true);
    form?.addEventListener("compositionend", endComposition, true);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(layoutFrame);
      document.removeEventListener("wheel", wheel, true);
      window.removeEventListener("focus", windowFocus);
      form?.removeEventListener("pointerdown", editorInteraction, true);
      form?.removeEventListener("focusin", focus);
      form?.removeEventListener("beforeinput", expand);
      form?.removeEventListener("keydown", editorInteraction, true);
      form?.removeEventListener("paste", expand, true);
      form?.removeEventListener("compositionstart", startComposition, true);
      form?.removeEventListener("compositionend", endComposition, true);
      cancelAnimationFrame(focusFrame);
      refocusing.current = false;
    };
  }, [enabled, threadId, blocked, formRef, getTimeline, expand]);

  return { collapsed, expand };
}
