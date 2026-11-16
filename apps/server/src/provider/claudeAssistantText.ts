import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { RuntimeItemId, type ProviderRuntimeEvent, type TurnId } from "@t3tools/contracts";
import { Effect, Random } from "effect";

export interface AssistantTextBlockState {
  readonly itemId: string;
  readonly blockIndex: number;
  emittedTextDelta: boolean;
  readonly emittedTextParts: string[];
  fallbackText: string;
  streamClosed: boolean;
  completionEmitted: boolean;
}

export function extractAssistantTextBlocks(message: SDKMessage): Array<string> {
  if (message.type !== "assistant") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const fragments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (
      candidate.type === "text" &&
      typeof candidate.text === "string" &&
      candidate.text.length > 0
    ) {
      fragments.push(candidate.text);
    }
  }

  return fragments;
}

interface AssistantTextTurn {
  readonly turnId: TurnId;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: AssistantTextBlockState[];
  nextSyntheticAssistantBlockIndex: number;
}
type TextEvent = Extract<ProviderRuntimeEvent, { type: "content.delta" | "item.completed" }>;
type EmittedTextEvent = TextEvent extends infer E
  ? E extends TextEvent
    ? Pick<E, "type" | "itemId" | "turnId" | "payload" | "raw">
    : never
  : never;

/** Keeps completion text and stream deltas in the same ordered block state. */
export function makeClaudeAssistantText<C extends { turnState: AssistantTextTurn | undefined }>(
  emit: (context: C, event: EmittedTextEvent) => Effect.Effect<void>,
) {
  const ensureAssistantTextBlock = (
    context: C,
    blockIndex: number,
    options?: {
      readonly fallbackText?: string;
      readonly streamClosed?: boolean;
    },
  ): Effect.Effect<
    | {
        readonly blockIndex: number;
        readonly block: AssistantTextBlockState;
      }
    | undefined
  > =>
    Effect.gen(function* () {
      const turnState = context.turnState;
      if (!turnState) {
        return undefined;
      }

      const existing = turnState.assistantTextBlocks.get(blockIndex);
      if (existing && !existing.completionEmitted) {
        if (existing.fallbackText.length === 0 && options?.fallbackText) {
          existing.fallbackText = options.fallbackText;
        }
        if (options?.streamClosed) {
          existing.streamClosed = true;
        }
        return { blockIndex, block: existing };
      }

      const block: AssistantTextBlockState = {
        itemId: yield* Random.nextUUIDv4,
        blockIndex,
        emittedTextDelta: false,
        emittedTextParts: [],
        fallbackText: options?.fallbackText ?? "",
        streamClosed: options?.streamClosed ?? false,
        completionEmitted: false,
      };
      turnState.assistantTextBlocks.set(blockIndex, block);
      turnState.assistantTextBlockOrder.push(block);
      return { blockIndex, block };
    });

  const createSyntheticAssistantTextBlock = (
    context: C,
    fallbackText: string,
  ): Effect.Effect<
    | {
        readonly blockIndex: number;
        readonly block: AssistantTextBlockState;
      }
    | undefined
  > =>
    Effect.gen(function* () {
      const turnState = context.turnState;
      if (!turnState) {
        return undefined;
      }

      const blockIndex = turnState.nextSyntheticAssistantBlockIndex;
      turnState.nextSyntheticAssistantBlockIndex -= 1;
      return yield* ensureAssistantTextBlock(context, blockIndex, {
        fallbackText,
        streamClosed: true,
      });
    });

  const completeAssistantTextBlock = (
    context: C,
    block: AssistantTextBlockState,
    options?: {
      readonly force?: boolean;
      readonly rawMethod?: string;
      readonly rawPayload?: unknown;
    },
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const turnState = context.turnState;
      if (!turnState || block.completionEmitted) {
        return;
      }

      if (!options?.force && !block.streamClosed) {
        return;
      }

      if (!block.emittedTextDelta && block.fallbackText.length > 0) {
        yield* emit(context, {
          type: "content.delta",
          turnId: turnState.turnId,
          itemId: RuntimeItemId.make(block.itemId),
          payload: {
            streamKind: "assistant_text",
            delta: block.fallbackText,
          },
          ...(options?.rawMethod || options?.rawPayload
            ? {
                raw: {
                  source: "claude.sdk.message" as const,
                  ...(options.rawMethod ? { method: options.rawMethod } : {}),
                  payload: options?.rawPayload,
                },
              }
            : {}),
        });
      }

      block.completionEmitted = true;
      if (turnState.assistantTextBlocks.get(block.blockIndex) === block) {
        turnState.assistantTextBlocks.delete(block.blockIndex);
      }

      yield* emit(context, {
        type: "item.completed",
        itemId: RuntimeItemId.make(block.itemId),
        turnId: turnState.turnId,
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Assistant message",
          data: {
            text: block.emittedTextDelta ? block.emittedTextParts.join("") : block.fallbackText,
          },
          ...(block.fallbackText.length > 0 ? { detail: block.fallbackText } : {}),
        },
        ...(options?.rawMethod || options?.rawPayload
          ? {
              raw: {
                source: "claude.sdk.message" as const,
                ...(options.rawMethod ? { method: options.rawMethod } : {}),
                payload: options?.rawPayload,
              },
            }
          : {}),
      });
    });

  const backfillAssistantTextBlocksFromSnapshot = (
    context: C,
    message: SDKMessage,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const turnState = context.turnState;
      if (!turnState) {
        return;
      }

      const snapshotTextBlocks = extractAssistantTextBlocks(message);
      if (snapshotTextBlocks.length === 0) {
        return;
      }

      const orderedBlocks = turnState.assistantTextBlockOrder.map((block) => ({
        blockIndex: block.blockIndex,
        block,
      }));

      for (const [position, text] of snapshotTextBlocks.entries()) {
        const existingEntry = orderedBlocks[position];
        const entry =
          existingEntry ??
          (yield* createSyntheticAssistantTextBlock(context, text).pipe(
            Effect.map((created) => {
              if (!created) {
                return undefined;
              }
              orderedBlocks.push(created);
              return created;
            }),
          ));
        if (!entry) {
          continue;
        }

        if (entry.block.fallbackText.length === 0) {
          entry.block.fallbackText = text;
        }

        if (entry.block.streamClosed && !entry.block.completionEmitted) {
          yield* completeAssistantTextBlock(context, entry.block, {
            rawMethod: "claude/assistant",
            rawPayload: message,
          });
        }
      }
    });

  return {
    ensureAssistantTextBlock,
    createSyntheticAssistantTextBlock,
    completeAssistantTextBlock,
    backfillAssistantTextBlocksFromSnapshot,
  };
}
