import { useEffect, useRef } from "react";
import type { TimelineEntry } from "../../session-logic";
import type { ScreenReaderAnnouncements } from "../../appSettings";
import {
  EMPTY_TURN_DETAIL,
  nextTurnDetailAnnouncement,
  turnDetail,
  type TurnDetailMemory,
} from "./turnDetailAnnouncement";

/** Separate from status so an approval cannot replace an agent message unheard. */
export function TurnDetailAnnouncer(props: {
  threadId: string;
  turnId: string | null;
  level: ScreenReaderAnnouncements;
  working: boolean;
  active: boolean;
  entries: readonly TimelineEntry[];
}) {
  const region = useRef<HTMLDivElement>(null);
  const memory = useRef<{ key: string; value: TurnDetailMemory } | null>(null);
  const quietUntil = useRef(0);
  const pending = useRef<string | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const key = `${props.threadId}:${props.turnId}`;
    const previous = memory.current?.key === key ? memory.current.value : null;
    const next = nextTurnDetailAnnouncement(
      previous,
      props.level === "status" ? EMPTY_TURN_DETAIL : turnDetail(props.entries, props.turnId),
      props.level,
      props.active,
      props.working,
    );
    memory.current = { key, value: next.memory };
    const clear = () => {
      if (clearTimer.current !== undefined) clearTimeout(clearTimer.current);
      if (region.current) region.current.textContent = "";
    };
    const write = (text: string) => {
      clear();
      if (region.current) region.current.textContent = text;
      clearTimer.current = setTimeout(clear, 7000);
    };
    if (previous === null || previous.level !== props.level || !props.active) {
      pending.current = null;
      quietUntil.current = 0;
      clear();
      return;
    }
    if (next.messages.length > 0) {
      const text = next.messages.join(" ");
      write(text);
      quietUntil.current = Date.now() + Math.min(15000, Math.max(2000, text.length * 50));
    }
    pending.current =
      props.working && props.level === "everything" && next.memory.activity !== null
        ? (next.activity ?? pending.current)
        : null;
    if (pending.current === null) return;
    const timer = setTimeout(
      () => {
        if (pending.current !== null) write(pending.current);
        pending.current = null;
        quietUntil.current = Date.now() + 2000;
      },
      Math.max(0, quietUntil.current - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [props.threadId, props.turnId, props.level, props.working, props.active, props.entries]);
  useEffect(
    () => () => {
      if (clearTimer.current !== undefined) clearTimeout(clearTimer.current);
    },
    [],
  );
  return <div ref={region} className="sr-only" aria-live="polite" aria-atomic="true" />;
}
