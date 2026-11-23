import { TextQuoteIcon } from "lucide-react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { captureAssistantQuoteSelection } from "../../lib/assistantQuoteSelection";
import { Button } from "../ui/button";
import { Popover, PopoverPopup } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import {
  assistantQuoteLimitError,
  type AssistantQuote,
} from "./composer/ComposerAssistantQuoteNode";

interface SelectionAnchor {
  getBoundingClientRect: () => DOMRect;
  contextElement: Element;
}

/**
 * The selected text's boundaries, kept as positions rather than a live Range: a virtualized
 * timeline moves rows in and out of the DOM, which collapses any Range pointing into them even
 * though the same text nodes come back.
 */
interface QuoteBounds {
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
  text: string;
}

function boundsOf(range: Range): QuoteBounds {
  return {
    startContainer: range.startContainer,
    startOffset: range.startOffset,
    endContainer: range.endContainer,
    endOffset: range.endOffset,
    text: range.toString(),
  };
}

function sameBounds(left: QuoteBounds, right: QuoteBounds): boolean {
  return (
    left.startContainer === right.startContainer &&
    left.startOffset === right.startOffset &&
    left.endContainer === right.endContainer &&
    left.endOffset === right.endOffset
  );
}

/** A fresh range over the quoted text, or null once that text is gone or has changed. */
function rangeFromBounds(bounds: QuoteBounds): Range | null {
  if (!bounds.startContainer.isConnected || !bounds.endContainer.isConnected) return null;
  const range = bounds.startContainer.ownerDocument!.createRange();
  try {
    range.setStart(bounds.startContainer, bounds.startOffset);
    range.setEnd(bounds.endContainer, bounds.endOffset);
  } catch {
    return null;
  }
  return range.toString() === bounds.text ? range : null;
}

/**
 * Positions the quote actions against the selected text, which stays measurable after focus
 * moves into the comment box and replaces the document selection. While the text is
 * unavailable, the last real rect is kept.
 */
export function createSelectionAnchor(
  bounds: QuoteBounds,
  contextElement: Element,
): SelectionAnchor {
  let lastRect = rangeFromBounds(bounds)?.getBoundingClientRect() ?? new DOMRect();
  return {
    contextElement,
    getBoundingClientRect() {
      const rect = rangeFromBounds(bounds)?.getBoundingClientRect();
      if (rect && (rect.width > 0 || rect.height > 0)) lastRect = rect;
      return lastRect;
    },
  };
}

interface QuoteSelection {
  messageId: string;
  text: string;
  bounds: QuoteBounds;
  anchor: SelectionAnchor;
}

export function AssistantQuoteToolbar({
  onInsert,
  currentLength,
  maxLength,
  rootRef,
}: {
  onInsert: (
    quote: AssistantQuote,
    send: boolean,
  ) => Promise<{ inserted: boolean; error?: string }> | { inserted: boolean; error?: string };
  currentLength: number;
  maxLength: number;
  /** Only selections inside this element are offered, so side-by-side chats stay separate. */
  rootRef?: RefObject<HTMLElement | null>;
}) {
  const [selection, setSelection] = useState<QuoteSelection | null>(null);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [alreadyInserted, setAlreadyInserted] = useState(false);
  const selectionRef = useRef<QuoteSelection | null>(null);
  const pointerSelectingRef = useRef(false);
  // Stepping back from the comment: until the quoted text is selected again, empty selection
  // reads come from focus moving out of the comment box and must not hide the actions.
  const detachedRef = useRef(false);
  const restoreBoundsRef = useRef<QuoteBounds | null>(null);
  // Only a real dismissal hands focus back; the popup otherwise moves focus to the composer
  // when its contents change.
  const closingRef = useRef(false);
  const quoteButtonRef = useRef<HTMLButtonElement>(null);
  /** Shows other actions, or none; a draft never carries over to a different quote. */
  const replaceSelection = useCallback((next: QuoteSelection | null) => {
    const current = selectionRef.current;
    if (
      current === next ||
      (current &&
        next &&
        current.messageId === next.messageId &&
        current.text === next.text &&
        sameBounds(current.bounds, next.bounds))
    ) {
      return;
    }
    selectionRef.current = next;
    setSelection(next);
    setComment("");
    setError("");
    setAlreadyInserted(false);
  }, []);
  useEffect(() => {
    if (editing) return;
    const inToolbar = (event: Event) =>
      event.target instanceof Element && event.target.closest("[data-quote-toolbar]") !== null;
    const capture = () => {
      const selected = captureAssistantQuoteSelection(window.getSelection());
      const root = rootRef?.current;
      if (!selected || (root && !root.contains(selected.source))) {
        if (!detachedRef.current) replaceSelection(null);
        return;
      }
      detachedRef.current = false;
      closingRef.current = false;
      const bounds = boundsOf(selected.range);
      replaceSelection({
        messageId: selected.source.getAttribute("data-message-id")!,
        text: selected.text,
        bounds,
        anchor: createSelectionAnchor(bounds, selected.source),
      });
    };
    const clear = () => {
      detachedRef.current = false;
      restoreBoundsRef.current = null;
      replaceSelection(null);
    };
    // A new press clears stale actions; its selection is read once the press ends. Pointer
    // listeners capture, so presses that stop propagation still count.
    const onPointerDown = (event: Event) => {
      if (inToolbar(event)) return;
      pointerSelectingRef.current = true;
      clear();
    };
    const onPointerUp = (event: Event) => {
      pointerSelectingRef.current = false;
      if (inToolbar(event)) return;
      // Buttons can preserve a prior DOM selection; do not reopen actions beside them.
      if (event.target instanceof Element && event.target.closest("button, [role=button]")) {
        clear();
        return;
      }
      capture();
    };
    // A release outside the window never arrives; a move with no button pressed ends the press.
    const onPointerMove = (event: PointerEvent) => {
      if (!pointerSelectingRef.current || (event.buttons & 1) !== 0) return;
      pointerSelectingRef.current = false;
      capture();
    };
    const onBlur = () => {
      pointerSelectingRef.current = false;
    };
    // Keyboard and touch-handle selections report only through selectionchange.
    let frame = 0;
    const onSelectionChange = () => {
      if (pointerSelectingRef.current || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!pointerSelectingRef.current) capture();
      });
    };
    // Leaving the comment box: the popup moves focus as the box unmounts, so let that settle,
    // then focus the action and re-highlight the quoted text. If that text is gone, so is
    // the quote.
    let restoreFrame = 0;
    if (restoreBoundsRef.current) {
      restoreFrame = requestAnimationFrame(() => {
        restoreFrame = requestAnimationFrame(() => {
          restoreFrame = 0;
          const bounds = restoreBoundsRef.current;
          restoreBoundsRef.current = null;
          const range = bounds && rangeFromBounds(bounds);
          if (!range) {
            clear();
            return;
          }
          quoteButtonRef.current?.focus({ preventScroll: true });
          const live = window.getSelection();
          live?.removeAllRanges();
          live?.addRange(range);
        });
      });
    }
    const capturing = { capture: true } as const;
    document.addEventListener("pointerdown", onPointerDown, capturing);
    document.addEventListener("pointerup", onPointerUp, capturing);
    document.addEventListener("pointercancel", onPointerUp, capturing);
    document.addEventListener("pointermove", onPointerMove, capturing);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("blur", onBlur);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(restoreFrame);
      restoreBoundsRef.current = null;
      document.removeEventListener("pointerdown", onPointerDown, capturing);
      document.removeEventListener("pointerup", onPointerUp, capturing);
      document.removeEventListener("pointercancel", onPointerUp, capturing);
      document.removeEventListener("pointermove", onPointerMove, capturing);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("blur", onBlur);
    };
  }, [editing, replaceSelection, rootRef]);
  if (!selection) return null;
  const close = () => {
    detachedRef.current = false;
    restoreBoundsRef.current = null;
    replaceSelection(null);
    setEditing(false);
  };
  const dismiss = () => {
    closingRef.current = true;
    close();
  };
  const leaveEditing = () => {
    detachedRef.current = true;
    restoreBoundsRef.current = selection.bounds;
    setEditing(false);
  };
  const insert = async (send = false) => {
    if (busy || alreadyInserted) return;
    const quote = { messageId: selection.messageId, text: selection.text, comment };
    const limitError = assistantQuoteLimitError(currentLength, quote, maxLength);
    if (limitError) {
      setError(limitError);
      return;
    }
    setBusy(true);
    try {
      const result = await onInsert(quote, send);
      if (result.error || !result.inserted) {
        setAlreadyInserted(result.inserted);
        setError(result.error ?? "The composer is not ready yet.");
        return;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add quote.");
      return;
    } finally {
      setBusy(false);
    }
    close();
    // Inserting focuses the composer; only clear a selection still left on the quoted text.
    const live = window.getSelection();
    if (live?.anchorNode && selection.anchor.contextElement.contains(live.anchorNode)) {
      live.removeAllRanges();
    }
  };
  return (
    <Popover
      open
      modal={false}
      onOpenChange={(open, details) => {
        if (open) return;
        if (!editing) {
          // The click that ends a mouse selection lands outside the actions; the selection
          // listeners above already hide them on a new press.
          if (details.reason !== "outside-press") dismiss();
          return;
        }
        // A stray click must not throw away a typed comment; Escape steps back to the action.
        if (details.reason === "escape-key" && !busy) leaveEditing();
      }}
    >
      <PopoverPopup
        data-quote-toolbar
        anchor={selection.anchor}
        side={editing ? "bottom" : "top"}
        align={editing ? "start" : "center"}
        sideOffset={8}
        tooltipStyle={!editing}
        initialFocus={false}
        finalFocus={() => closingRef.current}
        className={editing ? "w-96" : "in-data-anchor-hidden:invisible"}
        role={editing ? "dialog" : "toolbar"}
        aria-label="Quote assistant response"
      >
        {!editing ? (
          <Button ref={quoteButtonRef} size="sm" variant="ghost" onClick={() => setEditing(true)}>
            <TextQuoteIcon aria-hidden />
            Quote reply
          </Button>
        ) : (
          <>
            <blockquote className="max-h-32 overflow-auto border-l-2 pl-2 text-xs whitespace-pre-wrap">
              {selection.text}
            </blockquote>
            <Textarea
              autoFocus
              className="mt-2"
              disabled={busy || alreadyInserted}
              aria-label="Quote comment"
              value={comment}
              maxLength={4000}
              onChange={(event) => setComment(event.target.value)}
              onKeyDown={(event) => {
                if (
                  (event.metaKey || event.ctrlKey) &&
                  event.key === "Enter" &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  void insert(true);
                }
                if (event.key === "Escape") {
                  event.stopPropagation();
                  leaveEditing();
                }
              }}
            />
            {error && (
              <p role="alert" className="mt-2 text-destructive-foreground text-xs">
                {error}
              </p>
            )}
            <div className="mt-2 flex gap-2">
              <Button size="sm" disabled={busy || alreadyInserted} onClick={() => void insert()}>
                Add quote to composer
              </Button>
              <Button
                size="sm"
                disabled={busy || alreadyInserted}
                variant="ghost"
                onClick={leaveEditing}
              >
                Back
              </Button>
              <Button size="sm" disabled={busy} variant="ghost" onClick={dismiss}>
                {alreadyInserted ? "Close" : "Cancel"}
              </Button>
            </div>
          </>
        )}
      </PopoverPopup>
    </Popover>
  );
}
