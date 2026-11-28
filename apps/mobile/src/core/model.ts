import type {
  MobileBatch,
  MobileBootstrap,
  MobileHistory,
  MobileMessage,
  MobileShell,
  MobileThreadShell,
  MobileThreadTail,
} from "@t3tools/contracts/mobile/v1";
import { mergeMessageText } from "@t3tools/shared/messageMerge";
import { create } from "zustand";
import type { PairedServer } from "./pairing";
import type { LinkState } from "./wsClient";

export const MAX_MESSAGES = 500;
export type Detail = typeof MobileThreadTail.Type & {
  cursor: typeof MobileHistory.Type.cursor;
};
type Shell = typeof MobileThreadShell.Type;
type Batch = typeof MobileBatch.Type;

export interface MobileModel {
  loaded: boolean;
  server: PairedServer | null;
  info: typeof MobileBootstrap.Type | null;
  status: LinkState;
  active: boolean;
  selected: string | null;
  shell: typeof MobileShell.Type | null;
  details: ReadonlyMap<string, Detail>;
  stale: boolean;
  syncTimedOut: boolean;
}

export const initialModel: MobileModel = {
  loaded: false,
  server: null,
  info: null,
  status: "connecting",
  active: true,
  selected: null,
  shell: null,
  details: new Map(),
  stale: true,
  syncTimedOut: false,
};
export const useMobileModel = create<MobileModel>(() => initialModel);

export function updateDetail(id: string, detail: Detail) {
  useMobileModel.setState(({ details }) => {
    const next = new Map(details);
    next.delete(id);
    next.set(id, detail);
    if (next.size > 5) {
      const oldest = next.keys().next().value;
      if (oldest !== undefined) next.delete(oldest);
    }
    return { details: next };
  });
}

export function applyMessageBatch(
  detail: Detail,
  batch: Batch,
): { detail: Detail; needsTail: boolean } {
  if (batch.throughSequence <= detail.snapshotSequence) return { detail, needsTail: false };
  const messages = new Map(detail.messages.map((message) => [message.messageId, message]));
  let needsTail = batch.tailInvalidated;
  const oldest = detail.messages[0];
  for (const patch of batch.messages) {
    if (patch.sequence <= detail.snapshotSequence) continue;
    const existing = messages.get(patch.messageId);
    if (!existing && oldest && patch.createdAt < oldest.createdAt) {
      needsTail = true;
      continue;
    }
    const next: typeof MobileMessage.Type = {
      messageId: patch.messageId,
      role: patch.role,
      createdAt: existing?.createdAt ?? patch.createdAt,
      text: mergeMessageText(existing, {
        text: patch.text,
        streaming: patch.mode === "append",
        replace: patch.mode === "replace",
      }).text,
      streaming: patch.streaming,
    };
    messages.set(patch.messageId, next);
  }
  const ordered = [...messages.values()].slice(-MAX_MESSAGES);
  return {
    detail: {
      ...detail,
      messages: ordered,
      snapshotSequence: batch.throughSequence,
      cursor: ordered.length >= MAX_MESSAGES ? null : detail.cursor,
    },
    needsTail:
      needsTail ||
      batch.messages.some(
        (message) => message.completed && message.sequence > detail.snapshotSequence,
      ),
  };
}

export function replaceShellEntries(
  shell: typeof MobileShell.Type,
  fresh: typeof MobileShell.Type,
  ids: readonly string[],
) {
  const threads = new Map<string, Shell>(shell.threads.map((thread) => [thread.id, thread]));
  for (const id of ids) threads.delete(id);
  for (const thread of fresh.threads) threads.set(thread.id, thread);
  return { ...shell, threads: [...threads.values()] };
}

export function mergeHistory(detail: Detail, page: typeof MobileHistory.Type): Detail {
  const byId = new Map(page.messages.map((message) => [message.messageId, message]));
  for (const message of detail.messages) byId.set(message.messageId, message);
  const messages = [...byId.values()].slice(-MAX_MESSAGES);
  return { ...detail, messages, cursor: messages.length >= MAX_MESSAGES ? null : page.cursor };
}
