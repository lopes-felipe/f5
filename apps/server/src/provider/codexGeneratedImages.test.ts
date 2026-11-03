import { EventId, ProviderItemId, ThreadId, TurnId, type ProviderEvent } from "@t3tools/contracts";
import { expect, it } from "vitest";
import { CodexGeneratedImages } from "./codexGeneratedImages.ts";

const event = (method: string, item?: Record<string, unknown>): ProviderEvent => ({
  id: EventId.makeUnsafe(method + ":" + String(item?.id)),
  kind: "notification",
  provider: "codex",
  threadId: ThreadId.make("thread"),
  turnId: TurnId.make("turn"),
  ...(item ? { itemId: ProviderItemId.make(String(item.id)) } : {}),
  createdAt: "2026-11-03T00:00:00Z",
  method,
  payload: item ? { item } : { turn: { status: "completed" } },
});

it("forwards messages and the native terminal immediately, then emits late images separately", () => {
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
  ).toHaveLength(1);
  expect(images.project(event("turn/completed"))).toEqual([event("turn/completed")]);
  const output = images.project(
    event("item/completed", {
      type: "imageGeneration",
      id: "image",
      status: "completed",
      savedPath: "C:\\images\\a.png",
    }),
  );
  expect(output.map((entry) => entry.method)).toEqual(["item/completed", "item/completed"]);
  expect(output[1]?.payload).toMatchObject({
    item: { text: "![](<C:/images/a.png>)" },
  });
});

it("never delays async questions or phase-less completions and flushes saved previews on close", () => {
  const images = new CodexGeneratedImages();
  images.project(event("item/started", { type: "imageGeneration", id: "image" }));
  const question = event("item/completed", {
    type: "agentMessage",
    id: "question",
    delivery: "async",
    questions: [{ title: "Choose?" }],
  });
  expect(images.project(question)).toEqual([question]);
  const answer = event("item/completed", { type: "agentMessage", id: "answer", text: "Done" });
  expect(images.project(answer)).toEqual([answer]);
  images.project(
    event("item/completed", {
      type: "imageGeneration",
      id: "image",
      status: "completed",
      savedPath: "/tmp/a.png",
    }),
  );
  const closed = images.project(event("session/closed"));
  expect(closed[0]?.payload).toMatchObject({ item: { text: "![](</tmp/a.png>)" } });
  expect(closed.at(-1)?.method).toBe("session/closed");
});

it("drops cancelled background work and never publishes the late image", () => {
  const images = new CodexGeneratedImages();
  images.project(event("item/started", { type: "imageGeneration", id: "image" }));
  expect(images.project(event("turn/completed"))).toHaveLength(1);
  images.cancel(ThreadId.make("thread"), TurnId.make("turn"));
  expect(
    images.project(
      event("item/completed", {
        type: "imageGeneration",
        id: "image",
        status: "completed",
        savedPath: "/tmp/late.png",
      }),
    ),
  ).toHaveLength(1);
  expect(images.project(event("session/closed"))).toHaveLength(1);
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
