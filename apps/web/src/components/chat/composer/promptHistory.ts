import { deriveDisplayedUserMessageState } from "~/lib/terminalContext";
import { IMAGE_ONLY_BOOTSTRAP_PROMPT } from "~/lib/composerSendText";
import {
  normalizeComposerMentions,
  replaceComposerMentionRange,
  type ComposerMention,
} from "~/composer-editor-mentions";

export interface PromptHistoryMessage {
  id: string;
  role: string;
  text: string;
}
export interface PromptHistoryPosition {
  threadId: string;
  messageId: string;
  text: string;
}

/** Recall only user text; terminal/file context belongs to the original turn. */
export function recallablePrompt(text: string): string {
  return recallablePromptWithMentions(text).prompt;
}

/** Apply each recall edit to text and occurrence offsets together. */
export function recallablePromptWithMentions(
  text: string,
  mentions: readonly ComposerMention[] = [],
): { prompt: string; mentions: ComposerMention[] } {
  const displayed = deriveDisplayedUserMessageState(text);
  let prompt = displayed.visibleText;
  let recalledMentions = normalizeComposerMentions(prompt, mentions);
  for (const context of displayed.contexts) {
    const match = /^(.+?) lines? (\d+(?:-\d+)?)$/.exec(context.header);
    if (!match) continue;
    const label = `@${match[1]!.toLowerCase().replace(/\s+/g, "-")}:${match[2]}`;
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const removed = new RegExp(`${escaped}(?![\\d-]) ?`).exec(prompt);
    if (removed) {
      recalledMentions = replaceComposerMentionRange(
        recalledMentions,
        removed.index,
        removed.index + removed[0].length,
        0,
      );
      prompt = prompt.slice(0, removed.index) + prompt.slice(removed.index + removed[0].length);
    }
  }
  if (prompt === IMAGE_ONLY_BOOTSTRAP_PROMPT) return { prompt: "", mentions: [] };
  return { prompt, mentions: recalledMentions };
}

export function stepPromptHistory(input: {
  threadId: string;
  messages: readonly PromptHistoryMessage[];
  position: PromptHistoryPosition | null;
  prompt: string;
  direction: "up" | "down";
}): { prompt: string; position: PromptHistoryPosition | null } | null {
  const entries = input.messages
    .filter((message) => message.role === "user")
    .map((message) => ({ id: message.id, text: recallablePrompt(message.text) }))
    .filter((message) => message.text.trim().length > 0);
  const position = input.position;
  const index =
    position?.threadId === input.threadId && position.text === input.prompt
      ? entries.findIndex((entry) => entry.id === position.messageId)
      : -1;
  if (index < 0 && (input.prompt.length > 0 || input.direction === "down")) return null;
  const next = input.direction === "up" ? (index < 0 ? entries.length - 1 : index - 1) : index + 1;
  if (next < 0) return null;
  const entry = entries[next];
  if (!entry) return input.direction === "down" ? { prompt: "", position: null } : null;
  return {
    prompt: entry.text,
    position: { threadId: input.threadId, messageId: entry.id, text: entry.text },
  };
}
