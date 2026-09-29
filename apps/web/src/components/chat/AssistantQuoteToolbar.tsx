import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  serializeAssistantQuote,
  type AssistantQuote,
} from "./composer/ComposerAssistantQuoteNode";

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
  const [selection, setSelection] = useState<{ messageId: string; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [alreadyInserted, setAlreadyInserted] = useState(false);
  useEffect(() => {
    const capture = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("[data-quote-toolbar]")) return;
      if (editing) return;
      // Buttons can preserve a prior DOM selection; do not reopen actions beside them.
      if (event.target instanceof Element && event.target.closest("button, [role=button]")) {
        setSelection(null);
        return;
      }
      const selected = window.getSelection();
      const messageElement = (node: Node | null | undefined) =>
        (node instanceof Element ? node : node?.parentElement)?.closest(
          '[data-message-role="assistant"][data-message-id]',
        );
      const anchor = messageElement(selected?.anchorNode);
      const focus = messageElement(selected?.focusNode);
      const text = selected?.toString().trim();
      if (!anchor || anchor !== focus || !text) {
        setSelection(null);
        return;
      }
      setSelection({
        messageId: anchor.getAttribute("data-message-id")!,
        text: text.slice(0, 4000),
      });
    };
    document.addEventListener("pointerup", capture);
    document.addEventListener("keyup", capture);
    return () => {
      document.removeEventListener("pointerup", capture);
      document.removeEventListener("keyup", capture);
    };
  }, [editing]);
  if (!selection) return null;
  const insert = async (send = false) => {
    if (busy || alreadyInserted) return;
    if (maxLength <= 0) {
      setError("Waiting for server capabilities. Reconnect before adding a quote.");
      return;
    }
    const quote = { ...selection, comment };
    if (currentLength + serializeAssistantQuote(quote).length + 2 > maxLength) {
      setError("This quote would exceed the message limit.");
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
    window.getSelection()?.removeAllRanges();
  };
  return (
    <div
      data-quote-toolbar
      className="fixed bottom-28 right-6 z-40 max-w-sm rounded-xl border bg-popover p-3 shadow-xl"
      role={editing ? "dialog" : "toolbar"}
      aria-label="Quote assistant response"
    >
      {!editing ? (
        <Button size="sm" onClick={() => setEditing(true)}>
          Quote reply
        </Button>
      ) : (
        <>
          <blockquote className="max-h-32 overflow-auto border-l-2 pl-2 text-xs whitespace-pre-wrap">
            {selection.text}
          </blockquote>
          <Textarea
            autoFocus
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
                setEditing(false);
              }
            }}
          />
          {error && <p role="alert">{error}</p>}
          <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={busy || alreadyInserted} onClick={() => void insert()}>
              Add quote to composer
            </Button>
            <Button
              size="sm"
              disabled={busy || alreadyInserted}
              variant="ghost"
              onClick={() => setEditing(false)}
            >
              Back
            </Button>
            <Button
              size="sm"
              disabled={busy}
              variant="ghost"
              onClick={() => {
                setSelection(null);
                setComment("");
                setEditing(false);
                setAlreadyInserted(false);
              }}
            >
              {alreadyInserted ? "Close" : "Cancel"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
