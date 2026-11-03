import { EventId, RuntimeItemId, ThreadId, TurnId, type ProviderEvent } from "@t3tools/contracts";
import { expect, it } from "vitest";
import { CodexGeneratedImages } from "./codexGeneratedImages.ts";

const event = (method: string, item?: Record<string, unknown>): ProviderEvent => ({
  id: EventId.makeUnsafe(method + ":" + String(item?.id)),
  kind: "notification",
  provider: "codex",
  threadId: ThreadId.make("thread"),
  turnId: TurnId.make("turn"),
  ...(item ? { itemId: RuntimeItemId.make(String(item.id)) } : {}),
  createdAt: "2026-11-03T00:00:00Z",
  method,
  payload: item ? { item } : { turn: { status: "completed" } },
});

it("keeps a turn open for late image completion and appends images to the final reply", () => {
  const images = new CodexGeneratedImages();
  images.project(event("item/started", { type: "imageGeneration", id: "image" }));
  expect(
    images.project(
      event("item/completed", {
        type: "agentMessage",
        id: "answer",
        text: "Done.",
      }),
    ),
  ).toEqual([]);
  expect(images.project(event("turn/completed"))).toEqual([]);
  const output = images.project(
    event("item/completed", {
      type: "imageGeneration",
      id: "image",
      status: "completed",
      savedPath: "C:\\images\\a.png",
    }),
  );
  expect(output.map((entry) => entry.method)).toEqual([
    "item/completed",
    "item/completed",
    "turn/completed",
  ]);
  expect(output[1]?.payload).toMatchObject({
    item: { id: "answer", text: "Done.\n\n![](<C:/images/a.png>)" },
  });
});

it("creates an image-only reply, skips failed images and clears retired sessions", () => {
  const images = new CodexGeneratedImages();
  images.project(
    event("item/completed", {
      type: "imageGeneration",
      id: "image",
      status: "completed",
      savedPath: "/tmp/a.png",
    }),
  );
  expect(images.project(event("turn/completed"))[0]?.payload).toMatchObject({
    item: { text: "![](</tmp/a.png>)" },
  });
  images.project(event("item/started", { type: "imageGeneration", id: "failed" }));
  images.project(
    event("item/completed", { type: "imageGeneration", id: "failed", status: "failed" }),
  );
  expect(images.project(event("turn/completed"))).toHaveLength(1);
  images.project(event("item/started", { type: "imageGeneration", id: "retired" }));
  images.project(event("session/closed"));
  expect(images.project(event("turn/completed"))).toHaveLength(1);
});
