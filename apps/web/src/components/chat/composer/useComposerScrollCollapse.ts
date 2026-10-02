import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { shouldScrollTimeline } from "../timelineScrollTarget";

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
  const composing = useRef(false);
  const refocusing = useRef(false);
  const collapsed = enabled && !blocked && collapsedThread === threadId;
  const expand = useCallback(() => {
    const current = gesture.current;
    if (performance.now() - current.lastAt <= GESTURE_IDLE_MS) current.suppressed = true;
    current.delta = 0;
    setCollapsedThread(null);
  }, []);

  useEffect(() => {
    setCollapsedThread(null);
    composing.current = false;
    gesture.current = { delta: 0, lastAt: -Infinity, suppressed: false };
  }, [threadId, enabled]);

  useEffect(() => {
    if (blocked) expand();
  }, [blocked, expand]);

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
      if (event.ctrlKey || event.defaultPrevented || !(event.target instanceof Element)) return;
      const timeline = getTimeline();
      if (!timeline || !timeline.contains(event.target)) return;
      const now = performance.now();
      const current = gesture.current;
      if (now - current.lastAt > GESTURE_IDLE_MS) {
        current.delta = 0;
        current.suppressed = false;
      }
      current.lastAt = now;
      const selection = window.getSelection();
      const canScroll =
        event.deltaY < 0
          ? timeline.scrollTop > 1
          : timeline.scrollTop + timeline.clientHeight < timeline.scrollHeight - 1;
      if (
        blocked ||
        composing.current ||
        current.suppressed ||
        !canScroll ||
        timeline.scrollHeight <= timeline.clientHeight + 1 ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
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
        setCollapsedThread(threadId);
      }
    };
    // Expanding the timeline can remove its overflow. A resting composer is
    // useful only while there is history to scroll through.
    const observer = new ResizeObserver(() => {
      const timeline = getTimeline();
      if (timeline && timeline.scrollHeight <= timeline.clientHeight + 1) expand();
    });
    if (form) observer.observe(form);
    const timeline = getTimeline();
    if (timeline) observer.observe(timeline);
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
