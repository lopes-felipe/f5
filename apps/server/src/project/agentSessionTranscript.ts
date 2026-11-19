import { DateTime, Option, Schema } from "effect";
import {
  MAX_IMPORTED_SESSION_MESSAGES,
  MAX_IMPORTED_SESSION_MESSAGE_CHARS,
  MAX_IMPORTED_SESSION_TEXT_CHARS,
  type AgentSessionSource,
  type ProviderInstanceId,
  type ImportedSessionMessage,
} from "@t3tools/contracts";
import { truncateMiddleByCharacters } from "../orchestration/outputTruncation.ts";

const MAX_IMPORT_RECORDS = 100_000;
const IMPORTED_MESSAGE_TRUNCATION = "\n\n[... imported message truncated ...]\n\n";
export interface AgentSessionThread {
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
  readonly title: string;
  readonly model: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<ImportedSessionMessage>;
  readonly truncated: boolean;
}
type AgentSessionThreadMessage = ImportedSessionMessage;

function claudeUserText(text: string): { text: string; titleText: string } {
  if (
    /^(?:<(?:task-notification|local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr)>|\[Request interrupted by user(?: for tool use)?\]$)/.test(
      text,
    )
  )
    return { text: "", titleText: "" };
  const shellInput = /^<bash-input>([\s\S]*)<\/bash-input>$/.exec(text)?.[1];
  if (shellInput !== undefined) return { text: "!" + shellInput, titleText: "" };
  if (/^<command-(?:name|message)>/.test(text)) {
    const name =
      /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim() ||
      "/" + (/<command-message>([^<]*)<\/command-message>/.exec(text)?.[1]?.trim() ?? "");
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? "";
    return { text: args ? name + " " + args : name, titleText: args };
  }
  return { text, titleText: text };
}
function claudeTitle(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text && claudeUserText(text).text === text ? text : undefined;
}
const TranscriptContentBlock = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});

const TranscriptMessage = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(TranscriptContentBlock)])),
  model: Schema.optional(Schema.String),
});

const CodexTurnMetadata = Schema.Struct({
  turn_id: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
});

const TranscriptRecord = Schema.Struct({
  type: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  aiTitle: Schema.optional(Schema.String),
  customTitle: Schema.optional(Schema.String),
  isSidechain: Schema.optional(Schema.Boolean),
  isMeta: Schema.optional(Schema.Boolean),
  isCompactSummary: Schema.optional(Schema.Boolean),
  message: Schema.optional(TranscriptMessage),
  payload: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      session_id: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
      role: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      content: Schema.optional(Schema.Array(TranscriptContentBlock)),
      internal_chat_message_metadata_passthrough: Schema.optional(Schema.Unknown),
    }),
  ),
});

const decodeTranscriptRecord = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptRecord));
const decodeCodexTurnMetadata = Schema.decodeUnknownOption(CodexTurnMetadata);
function splitTranscriptRecords(contents: string, limit: number): string[] {
  const records = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  return records.split("\n", limit);
}

function extractText(
  content: string | ReadonlyArray<typeof TranscriptContentBlock.Type> | undefined,
): string {
  if (typeof content === "string") return content.trim();
  if (content === undefined) return "";
  return content
    .filter(
      (block) =>
        block.type === "text" || block.type === "input_text" || block.type === "output_text",
    )
    .map((block) => block.text?.trim() ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
}

function normalizeTimestamp(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const parsed = DateTime.make(value);
  return parsed ? DateTime.formatIso(parsed) : fallback;
}

function codexTurnId(metadata: unknown): string | null {
  const decoded = decodeCodexTurnMetadata(metadata);
  if (
    Option.isNone(decoded) ||
    typeof decoded.value.turn_id !== "string" ||
    decoded.value.turn_id.trim().length === 0
  ) {
    return null;
  }
  return decoded.value.turn_id;
}

/** Keep visible user and assistant text while ignoring tools, reasoning, and malformed records. */
export function parseAgentSessionTranscript(
  input: {
    readonly contents: string;
    readonly source: AgentSessionSource;
    readonly providerInstanceId: ProviderInstanceId;
    readonly fallbackSessionId: string;
    readonly lastActiveAtMs: number;
  },
  lines = splitTranscriptRecords(input.contents, MAX_IMPORT_RECORDS + 1),
): AgentSessionThread | null {
  if (lines.length > MAX_IMPORT_RECORDS) return null;
  const fallbackTimestamp = DateTime.formatIso(DateTime.makeUnsafe(input.lastActiveAtMs));
  // Claude filenames are session IDs. Codex rollout filenames include extra
  // timestamp text, so only transcript metadata can provide a resumable ID.
  let providerSessionId = input.source === "codex" ? "" : input.fallbackSessionId;
  let title: string | null = null;
  let customTitle: string | null = null;
  let claudeDerivedTitle: string | undefined;
  let bareCommandTitle: string | undefined;
  let hasAssistantMessage = false;
  let model: string | null = null;
  let hasCodexSessionId = false;
  let truncated = false;
  const messages: Array<AgentSessionThreadMessage & { readonly codexResponseUser: boolean }> = [];
  let firstUserMessage:
    | (AgentSessionThreadMessage & { readonly codexResponseUser: boolean })
    | undefined;
  function* decodedRecords() {
    for (const line of lines) {
      const decoded = decodeTranscriptRecord(line);
      if (Option.isSome(decoded)) yield decoded.value;
    }
  }

  // A Codex response item can include generated setup text beside the real
  // prompt. Suppress response-user records only when the shared turn ID and a
  // verbatim event copy prove which prompt the user submitted.
  const canonicalCodexResponseUserIndices = new Set<number>();
  let canonicalUserTextsInTurn = new Set<string>();
  let responseUsersInTurn: Array<{
    readonly index: number;
    readonly turnId: string;
    readonly text: string;
  }> = [];
  const finishCodexTurn = () => {
    const canonicalTurnIds = new Set(
      responseUsersInTurn.flatMap((responseUser) =>
        canonicalUserTextsInTurn.has(responseUser.text) ? [responseUser.turnId] : [],
      ),
    );
    for (const responseUser of responseUsersInTurn) {
      if (canonicalTurnIds.has(responseUser.turnId)) {
        canonicalCodexResponseUserIndices.add(responseUser.index);
      }
    }
    canonicalUserTextsInTurn = new Set();
    responseUsersInTurn = [];
  };
  if (input.source === "codex") {
    let recordIndex = -1;
    for (const record of decodedRecords()) {
      recordIndex += 1;
      if (
        record.type === "response_item" &&
        record.payload?.type === "message" &&
        record.payload.role === "assistant"
      ) {
        finishCodexTurn();
        continue;
      }
      if (record.type === "event_msg" && record.payload?.type === "user_message") {
        const text = record.payload.message?.trim() ?? "";
        if (text.length > 0) canonicalUserTextsInTurn.add(text);
        continue;
      }
      if (
        record.type === "response_item" &&
        record.payload?.type === "message" &&
        record.payload.role === "user"
      ) {
        const turnId = codexTurnId(record.payload.internal_chat_message_metadata_passthrough);
        const text = extractText(record.payload.content);
        if (turnId !== null && text.length > 0) {
          responseUsersInTurn.push({ index: recordIndex, turnId, text });
        }
      }
    }
    finishCodexTurn();
  }

  const retainMessage = (
    message: AgentSessionThreadMessage & { readonly codexResponseUser: boolean },
    titleText = message.text,
  ) => {
    if (firstUserMessage === undefined && message.role === "user") {
      firstUserMessage = message;
    }
    if (input.source === "claudeAgent" && message.role === "user" && !claudeDerivedTitle) {
      claudeDerivedTitle = titleText.trim().split("\n")[0]?.slice(0, 100).trim() || undefined;
      bareCommandTitle ??= message.text.trim().split("\n")[0]?.slice(0, 100).trim() || undefined;
    }
    hasAssistantMessage ||= message.role === "assistant";
    messages.push(message);
    if (messages.length > MAX_IMPORTED_SESSION_MESSAGES) {
      messages.shift();
      truncated = true;
    }
  };

  const hasMatchingCodexEventInTurn = (text: string) => {
    const comparisonText = text.trim();
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role === "assistant") return false;
      if (
        message?.role === "user" &&
        !message.codexResponseUser &&
        message.text.trim() === comparisonText
      ) {
        return true;
      }
    }
    return false;
  };

  let recordIndex = -1;
  for (const record of decodedRecords()) {
    recordIndex += 1;
    if (input.source === "claudeAgent") {
      if (
        record.isSidechain === true ||
        record.isMeta === true ||
        record.isCompactSummary === true
      ) {
        continue;
      }
      title = claudeTitle(record.aiTitle) ?? title;
      if (record.customTitle !== undefined) customTitle = claudeTitle(record.customTitle) ?? null;
      const messageModel = record.message?.model?.trim();
      // Claude uses this sentinel for local error responses. It is not a
      // model ID that can be selected when the imported session resumes.
      if (messageModel && messageModel !== "<synthetic>") model = messageModel;
      if (record.type !== "user" && record.type !== "assistant") {
        continue;
      }

      const rawText = extractText(record.message?.content);
      const { text, titleText } =
        record.type === "user" ? claudeUserText(rawText) : { text: rawText, titleText: rawText };
      if (text.length === 0) continue;
      retainMessage(
        {
          role: record.type,
          text,
          createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
          codexResponseUser: false,
        },
        titleText,
      );
      continue;
    }

    if (record.type === "session_meta") {
      const sessionId = record.payload?.id?.trim() || record.payload?.session_id?.trim();
      if (!hasCodexSessionId && sessionId) {
        providerSessionId = sessionId;
        hasCodexSessionId = true;
      }
      continue;
    }
    if (record.type === "turn_context" && record.payload?.model?.trim()) {
      model = record.payload.model.trim();
      continue;
    }
    if (record.type === "event_msg" && record.payload?.type === "user_message") {
      const text = record.payload.message ?? "";
      if (text.trim().length === 0) continue;
      // Codex can write the same prompt as both a response item and an event.
      // Remove only the matching response copy so mixed-format logs keep every
      // distinct user message.
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.role === "assistant") break;
        if (message?.codexResponseUser === true && message.text.trim() === text.trim()) {
          if (firstUserMessage === message) firstUserMessage = undefined;
          messages.splice(index, 1);
          break;
        }
      }
      retainMessage({
        role: "user",
        text,
        createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
        codexResponseUser: false,
      });
      continue;
    }
    if (
      record.type !== "response_item" ||
      record.payload?.type !== "message" ||
      (record.payload.role !== "user" && record.payload.role !== "assistant")
    ) {
      continue;
    }

    const extractedText = extractText(record.payload.content);
    if (extractedText.length === 0) continue;
    if (record.payload.role === "user" && canonicalCodexResponseUserIndices.has(recordIndex)) {
      continue;
    }
    if (record.payload.role === "user" && hasMatchingCodexEventInTurn(extractedText)) {
      continue;
    }
    retainMessage({
      role: record.payload.role,
      text: extractedText,
      createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
      codexResponseUser: record.payload.role === "user",
    });
  }

  const visibleMessages = messages.map(
    ({ codexResponseUser: _codexResponseUser, ...message }) => message,
  );
  if (
    providerSessionId.trim().length === 0 ||
    firstUserMessage === undefined ||
    (input.source === "claudeAgent" && !claudeDerivedTitle && !hasAssistantMessage)
  )
    return null;
  const firstUserMessageRetained = messages.includes(firstUserMessage);
  const { codexResponseUser: _codexResponseUser, ...visibleFirstUserMessage } = firstUserMessage;
  const retainedMessages = firstUserMessageRetained
    ? visibleMessages
    : [visibleFirstUserMessage, ...visibleMessages.slice(-(MAX_IMPORTED_SESSION_MESSAGES - 1))];
  const derivedTitle =
    input.source === "claudeAgent"
      ? (claudeDerivedTitle ?? bareCommandTitle)
      : visibleFirstUserMessage.text.trim().split("\n")[0]?.slice(0, 100).trim();

  const boundedMessages = retainedMessages.map((message) => {
    if (message.text.length <= MAX_IMPORTED_SESSION_MESSAGE_CHARS) return message;
    truncated = true;
    return {
      ...message,
      text: truncateMiddleByCharacters(message.text, {
        maxCharacters: MAX_IMPORTED_SESSION_MESSAGE_CHARS,
        headCharacters: Math.floor(
          (MAX_IMPORTED_SESSION_MESSAGE_CHARS - IMPORTED_MESSAGE_TRUNCATION.length) / 2,
        ),
        marker: IMPORTED_MESSAGE_TRUNCATION,
      }).output,
    };
  });
  if (
    boundedMessages.reduce((length, message) => length + message.text.length, 0) >
    MAX_IMPORTED_SESSION_TEXT_CHARS
  ) {
    truncated = true;
    // Keep the opening request and the newest messages that fit as a continuous suffix.
    const firstIndex = firstUserMessageRetained ? messages.indexOf(firstUserMessage) : 0;
    const first = boundedMessages[firstIndex]!;
    let remaining = MAX_IMPORTED_SESSION_TEXT_CHARS - first.text.length;
    let suffixStart = boundedMessages.length;
    while (suffixStart > firstIndex + 1) {
      const message = boundedMessages[suffixStart - 1]!;
      if (message.text.length > remaining) break;
      remaining -= message.text.length;
      suffixStart--;
    }
    boundedMessages.splice(firstIndex + 1, suffixStart - firstIndex - 1);
    boundedMessages.splice(0, firstIndex);
  }
  return {
    source: input.source,
    providerInstanceId: input.providerInstanceId,
    providerSessionId,
    title:
      customTitle ??
      title ??
      (derivedTitle && derivedTitle.length > 0 ? derivedTitle : "Imported thread"),
    model,
    createdAt: boundedMessages[0]?.createdAt ?? fallbackTimestamp,
    updatedAt: fallbackTimestamp,
    messages: boundedMessages,
    truncated,
  };
}
