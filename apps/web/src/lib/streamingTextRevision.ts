import type { ChatMessage } from "../types";

/** Transient provenance: never persisted and never inferred from matching text. */
export interface TextRevision {
  readonly epoch: object;
  readonly revision: number;
  readonly length: number;
  readonly recent: ReadonlyArray<{ readonly base: number; readonly suffix: string }>;
}
const MAX_SUFFIXES = 32;
const MAX_SUFFIX_CHARACTERS = 64 * 1024;
const revisions = new WeakMap<ChatMessage, { text?: TextRevision; reasoningText?: TextRevision }>();

export function messageTextRevision(
  message: ChatMessage,
  field: "text" | "reasoningText" = "text",
): TextRevision | undefined {
  return revisions.get(message)?.[field];
}

function appendRevision(before: TextRevision, suffix: string): TextRevision {
  if (suffix.length === 0) return before;
  const recent = [...before.recent, { base: before.revision, suffix }];
  let characters = recent.reduce((total, entry) => total + entry.suffix.length, 0);
  while (recent.length > MAX_SUFFIXES || characters > MAX_SUFFIX_CHARACTERS)
    characters -= recent.shift()!.suffix.length;
  return {
    epoch: before.epoch,
    revision: before.revision + 1,
    length: before.length + suffix.length,
    recent,
  };
}
interface TrimmedContent {
  readonly text: string;
  readonly revision: TextRevision;
  readonly trailing: string;
}
const trimmedReasoning = new WeakMap<ChatMessage, TrimmedContent>();
/** Preserve the existing trimmed display while trimming only each new suffix. */
export function messageReasoningContent(message: ChatMessage): TrimmedContent {
  let content = trimmedReasoning.get(message);
  if (!content) {
    const raw = message.reasoningText ?? "";
    const text = raw.trim();
    content = {
      text,
      revision: { epoch: {}, revision: 0, length: text.length, recent: [] },
      trailing: raw.slice(raw.trimEnd().length),
    };
    trimmedReasoning.set(message, content);
  }
  return content;
}

/** Called only where the reducer actually appends these exact suffixes. */
export function recordMessageAppend(
  previous: ChatMessage,
  next: ChatMessage,
  text: string,
  reasoningText: string,
): void {
  const advance = (field: "text" | "reasoningText", suffix: string): TextRevision => {
    const before = messageTextRevision(previous, field) ?? {
      epoch: {},
      revision: 0,
      length: (previous[field] ?? "").length,
      recent: [],
    };
    if (!revisions.has(previous)) revisions.set(previous, {});
    revisions.get(previous)![field] = before;
    return appendRevision(before, suffix);
  };
  revisions.set(next, {
    text: advance("text", text),
    reasoningText: advance("reasoningText", reasoningText),
  });
  const before = trimmedReasoning.get(previous);
  if (before) {
    const body = reasoningText.trimEnd();
    const suffix =
      body.length === 0 ? "" : before.text.length === 0 ? body.trimStart() : before.trailing + body;
    trimmedReasoning.set(next, {
      text: before.text + suffix,
      revision: appendRevision(before.revision, suffix),
      trailing:
        body.length === 0 ? before.trailing + reasoningText : reasoningText.slice(body.length),
    });
  }
}

/** A skipped render can consume a bounded suffix history; an expired base rebuilds. */
export function suffixSince(
  previous: TextRevision | undefined,
  next: TextRevision | undefined,
): string | null {
  if (!previous || !next || previous.epoch !== next.epoch || previous.revision > next.revision)
    return null;
  if (previous.revision === next.revision) return previous.length === next.length ? "" : null;
  const start = next.recent.findIndex((entry) => entry.base === previous.revision);
  if (start < 0) return null;
  const suffix = next.recent
    .slice(start)
    .map((entry) => entry.suffix)
    .join("");
  return previous.length + suffix.length === next.length ? suffix : null;
}

// Structural identity survives content-only appends. Hydration and replacements
// naturally get a new identity without retaining earlier message arrays.
const messageStructures = new WeakMap<ChatMessage[], object>();
const attachmentStructures = new WeakMap<ChatMessage[], object>();
const attachmentSources = new WeakMap<object, NonNullable<ChatMessage["attachments"]>>();
function attachmentStructure(messages: ChatMessage[]): object {
  let identity = attachmentStructures.get(messages);
  if (!identity) {
    identity = {};
    attachmentStructures.set(messages, identity);
  }
  return identity;
}
export function messageAttachmentSources(
  messages: ChatMessage[],
): NonNullable<ChatMessage["attachments"]> {
  const identity = attachmentStructure(messages);
  let sources = attachmentSources.get(identity);
  if (!sources) {
    sources = messages.flatMap((message) => message.attachments ?? []);
    attachmentSources.set(identity, sources);
  }
  return sources;
}
export function messageListStructure(messages: ChatMessage[]): object {
  let structure = messageStructures.get(messages);
  if (!structure) {
    structure = {};
    messageStructures.set(messages, structure);
  }
  return structure;
}
const derivedStructures = new WeakMap<
  object,
  {
    readonly overlays: ReadonlyArray<unknown>;
    readonly sourceAttachment: object;
    readonly message: object;
    readonly attachment: object;
  }
>();
/**
 * A list derived from another (attachment preview handoff, optimistic sends)
 * keeps one structural identity while the source's structure and every overlay
 * are unchanged, so streaming text through it stays on the cheap path. The
 * caller must keep unchanged derived messages referentially stable.
 */
export function linkDerivedMessageList(
  source: ChatMessage[],
  next: ChatMessage[],
  overlays: ReadonlyArray<unknown>,
): ChatMessage[] {
  if (next === source) return next;
  const sourceMessage = messageListStructure(source);
  const sourceAttachment = attachmentStructure(source);
  const cached = derivedStructures.get(sourceMessage);
  const sameOverlays =
    cached !== undefined &&
    cached.overlays.length === overlays.length &&
    cached.overlays.every((overlay, index) => Object.is(overlay, overlays[index]));
  const linked = {
    overlays,
    sourceAttachment,
    message: sameOverlays ? cached.message : {},
    attachment:
      sameOverlays && cached.sourceAttachment === sourceAttachment ? cached.attachment : {},
  };
  derivedStructures.set(sourceMessage, linked);
  messageStructures.set(next, linked.message);
  attachmentStructures.set(next, linked.attachment);
  return next;
}
export function recordMessageListChange(
  previous: ChatMessage[],
  next: ChatMessage[],
  before: ChatMessage | undefined,
  after: ChatMessage,
): void {
  const textOnly =
    before &&
    before.id === after.id &&
    before.role === after.role &&
    before.createdAt === after.createdAt &&
    before.completedAt === after.completedAt &&
    before.streaming === after.streaming &&
    before.turnId === after.turnId &&
    before.attachments === after.attachments &&
    before.skillCall === after.skillCall;
  messageStructures.set(next, textOnly ? messageListStructure(previous) : {});
  const sameAttachments = before
    ? before.attachments === after.attachments
    : !after.attachments?.length;
  attachmentStructures.set(next, sameAttachments ? attachmentStructure(previous) : {});
}
