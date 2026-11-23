import { TextQuoteIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
 * Positions the quote actions against the selected text. The range is a clone, so it keeps
 * its geometry after focus moves into the comment box and replaces the document selection.
 * A collapsed or detached range measures as an empty rect; the last real rect is kept then.
 */
export function createSelectionAnchor(range: Range, contextElement: Element): SelectionAnchor {
  let lastRect = range.getBoundingClientRect();
  return {
    contextElement,
    getBoundingClientRect() {
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) lastRect = rect;
      return lastRect;
    },
  };
}

function sameRange(left: Range, right: Range): boolean {
  return (
    left.startContainer === right.startContainer &&
    left.startOffset === right.startOffset &&
    left.endContainer === right.endContainer &&
    left.endOffset === right.endOffset
  );
}

export function AssistantQuoteToolbar({
  onInsert,
  currentLength,
  maxLength,
}: {
  onInsert: (
    quote: AssistantQuote,
    send: boolean,
  ) => Promise<{ inserted: boolean; error?: string }> | { inserted: boolean; error?: string };
  currentLength: number;
  maxLength: number;
}) {
  const [selection, setSelection] = useState<{
    messageId: string;
    text: string;
    range: Range;
    anchor: SelectionAnchor;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [alreadyInserted, setAlreadyInserted] = useState(false);
  const pointerSelectingRef = useRef(false);
  // After stepping back from the comment, the quoted text may no longer be selected (the
  // comment box took the selection, and the message can re-render meanwhile). The actions
  // then stay until a new press, Escape, or a new quotable selection replaces them.
  const detachedRef = useRef(false);
  const restoreRangeRef = useRef<Range | null>(null);
  // Only a real dismissal hands focus back; the popup otherwise moves focus to the composer
  // when its contents change.
  const closingRef = useRef(false);
  const quoteButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (editing) return;
    const inToolbar = (event: Event) =>
      event.target instanceof Element && event.target.closest("[data-quote-toolbar]") !== null;
    const capture = () => {
      const selected = captureAssistantQuoteSelection(window.getSelection());
      if (!selected) {
        if (!detachedRef.current) setSelection(null);
        return;
      }
      detachedRef.current = false;
      closingRef.current = false;
      const messageId = selected.source.getAttribute("data-message-id")!;
      setSelection((current) =>
        current &&
        current.messageId === messageId &&
        current.text === selected.text &&
        sameRange(current.range, selected.range)
          ? current
          : {
              messageId,
              text: selected.text,
              range: selected.range,
              anchor: createSelectionAnchor(selected.range, selected.source),
            },
      );
    };
    // A new press clears stale actions; its selection is read once the press ends.
    const onPointerDown = (event: Event) => {
      if (inToolbar(event)) return;
      pointerSelectingRef.current = true;
      detachedRef.current = false;
      restoreRangeRef.current = null;
      setSelection(null);
    };
    const onPointerUp = (event: Event) => {
      pointerSelectingRef.current = false;
      if (inToolbar(event)) return;
      // Buttons can preserve a prior DOM selection; do not reopen actions beside them.
      if (event.target instanceof Element && event.target.closest("button, [role=button]")) {
        setSelection(null);
        return;
      }
      capture();
    };
    // Detached actions have no selection to follow; moving focus elsewhere moves on from them.
    const onFocusIn = (event: Event) => {
      if (!detachedRef.current || inToolbar(event)) return;
      detachedRef.current = false;
      restoreRangeRef.current = null;
      setSelection(null);
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
    // then focus the action and re-highlight the quoted text if its range is still intact.
    let restoreFrame = 0;
    if (restoreRangeRef.current) {
      restoreFrame = requestAnimationFrame(() => {
        restoreFrame = requestAnimationFrame(() => {
          restoreFrame = 0;
          const range = restoreRangeRef.current;
          restoreRangeRef.current = null;
          if (!range) return;
          quoteButtonRef.current?.focus({ preventScroll: true });
          if (range.collapsed || !range.startContainer.isConnected) return;
          const live = window.getSelection();
          live?.removeAllRanges();
          live?.addRange(range.cloneRange());
        });
      });
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(restoreFrame);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [editing]);
  if (!selection) return null;
  const dismiss = () => {
    closingRef.current = true;
    detachedRef.current = false;
    setSelection(null);
    setComment("");
    setEditing(false);
    setAlreadyInserted(false);
    setError("");
  };
  const leaveEditing = () => {
    detachedRef.current = true;
    restoreRangeRef.current = selection.range;
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
    setComment("");
    setSelection(null);
    setEditing(false);
    setError("");
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
