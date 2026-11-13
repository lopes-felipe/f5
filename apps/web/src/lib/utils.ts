import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { timeOrderedUuid } from "@t3tools/shared/ids";
import { type CxOptions, cx } from "class-variance-authority";
import { extendTailwindMerge } from "tailwind-merge";
import * as Random from "effect/Random";
import * as Effect from "effect/Effect";

/**
 * tailwind-merge that knows the custom `text-2xs` / `text-ui` font sizes, so
 * `cn("text-ui", "text-muted-foreground")` keeps both and
 * `cn("text-xs", "text-2xs")` resolves to `text-2xs`.
 */
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["2xs", "ui"] } } });

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function isWindowsPlatform(platform: string): boolean {
  return /^win(dows)?/i.test(platform);
}

export function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Effect.runSync(Random.nextUUIDv4);
}

/** Time-ordered: command IDs are indexed on the server, where random keys scatter writes. */
export const newCommandId = (): CommandId => CommandId.makeUnsafe(timeOrderedUuid(randomUUID()));

export const newProjectId = (): ProjectId => ProjectId.makeUnsafe(randomUUID());

export const newThreadId = (): ThreadId => ThreadId.makeUnsafe(randomUUID());

export const newMessageId = (): MessageId => MessageId.makeUnsafe(randomUUID());
