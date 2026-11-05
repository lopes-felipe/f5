import { afterEach, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { ThreadId, type HtmlPreviewHostRequest } from "@t3tools/contracts";
import { makeHtmlPreviewBroker } from "./HtmlPreviewBroker.ts";

const threadId = ThreadId.makeUnsafe("html-thread");
const input = { html: "<p>Hello</p>", width: 728, appearance: "dark" as const };
afterEach(() => vi.useRealTimers());
it("reports desktop absence without starting a browser", async () => {
  expect(await Effect.runPromise(makeHtmlPreviewBroker().render(threadId, input))).toEqual({
    _tag: "Unavailable",
    message: "Preview unavailable; html_render still works.",
  });
});
it("accepts only the owning host and releases requests on disconnect", async () => {
  const broker = makeHtmlPreviewBroker();
  let request: HtmlPreviewHostRequest | undefined;
  broker.register("owner", {
    push: (value) =>
      Effect.sync(() => {
        request = value;
      }),
  });
  let settled = false;
  const pending = Effect.runPromise(broker.render(threadId, input)).then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  expect(request).not.toHaveProperty("html");
  expect(broker.readInput(request!.requestId)).toBe(input.html);
  broker.respond("other", {
    requestId: request!.requestId,
    result: { _tag: "Unavailable", message: "spoof" },
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  broker.unregister("owner");
  expect(broker.readInput(request!.requestId)).toBeNull();
  expect((await pending)._tag).toBe("Unavailable");
  broker.respond("owner", {
    requestId: request!.requestId,
    result: { _tag: "Unavailable", message: "late" },
  });
});
it("bounds concurrent requests and retires work after the 20 second deadline", async () => {
  vi.useFakeTimers();
  const broker = makeHtmlPreviewBroker();
  broker.register("owner", { push: () => Effect.void });
  const first = Effect.runPromise(broker.render(threadId, input));
  const second = Effect.runPromise(broker.render(threadId, input));
  expect(await Effect.runPromise(broker.render(threadId, input))).toEqual({
    _tag: "Unavailable",
    message: "HTML preview is busy. Retry shortly.",
  });
  await vi.advanceTimersByTimeAsync(19_999);
  let settled = false;
  void first.then(() => (settled = true));
  await Promise.resolve();
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await first).toEqual({
    _tag: "Unavailable",
    message: "HTML preview got no answer from the desktop within 20 seconds.",
  });
  await second;
  broker.close();
});
it("passes on the desktop's stage-specific timeout from its shorter deadline", async () => {
  vi.useFakeTimers();
  const broker = makeHtmlPreviewBroker();
  let request: HtmlPreviewHostRequest | undefined;
  broker.register("owner", {
    push: (value) =>
      Effect.sync(() => {
        request = value;
      }),
  });
  const pending = Effect.runPromise(broker.render(threadId, input));
  await vi.advanceTimersByTimeAsync(12_000);
  const result = {
    _tag: "Unavailable" as const,
    message: "HTML preview timed out while loading page after 12 seconds.",
  };
  broker.respond("owner", { requestId: request!.requestId, result });
  expect(await pending).toEqual(result);
  broker.close();
});
