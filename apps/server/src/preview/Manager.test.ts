import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { makePreviewManager } from "./Manager";

it.effect("opens, navigates, reports, lists, and closes preview sessions", () =>
  Effect.gen(function* () {
    const manager = makePreviewManager();
    const events: string[] = [];
    const unsubscribe = manager.subscribe((event) => {
      events.push(event.type);
    });

    const opened = yield* manager.open({
      threadId: "thread-preview" as never,
      url: "localhost:5173",
    });
    assert.equal(opened.navStatus._tag, "Loading");
    assert.equal(
      opened.navStatus._tag === "Loading" ? opened.navStatus.url : "",
      "http://localhost:5173/",
    );

    const navigated = yield* manager.navigate({
      threadId: "thread-preview" as never,
      tabId: opened.tabId,
      url: "127.0.0.1:3000",
    });
    assert.equal(navigated.navStatus._tag, "Loading");
    assert.equal(
      navigated.navStatus._tag === "Loading" ? navigated.navStatus.url : "",
      "http://127.0.0.1:3000/",
    );

    yield* manager.reportStatus({
      threadId: "thread-preview" as never,
      tabId: opened.tabId,
      navStatus: {
        _tag: "Success",
        url: "http://127.0.0.1:3000/",
        title: "Dev",
      },
      canGoBack: true,
      canGoForward: false,
    });

    const listed = yield* manager.list({ threadId: "thread-preview" as never });
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0]?.canGoBack, true);
    assert.equal(listed.sessions[0]?.navStatus._tag, "Success");

    yield* manager.close({ threadId: "thread-preview" as never, tabId: opened.tabId });
    const empty = yield* manager.list({ threadId: "thread-preview" as never });
    assert.deepEqual(empty.sessions, []);
    assert.deepEqual(events, ["opened", "navigated", "navigated", "closed"]);
    unsubscribe();
  }),
);

it.effect("fails navigation for unknown preview sessions", () =>
  Effect.gen(function* () {
    const manager = makePreviewManager();
    const result = yield* Effect.exit(
      manager.navigate({
        threadId: "thread-preview" as never,
        tabId: "missing" as never,
        url: "localhost:5173",
      }),
    );
    assert.equal(result._tag, "Failure");
  }),
);

it.effect("rejects non-loopback preview urls", () =>
  Effect.gen(function* () {
    const manager = makePreviewManager();
    const result = yield* Effect.exit(
      manager.open({
        threadId: "thread-preview" as never,
        url: "https://example.com",
      }),
    );
    assert.equal(result._tag, "Failure");
  }),
);

it.effect("closes every preview session for a thread when no tab id is provided", () =>
  Effect.gen(function* () {
    const manager = makePreviewManager();
    const threadId = "thread-preview" as never;
    const otherThreadId = "thread-other" as never;
    const closedTabIds: string[] = [];
    const unsubscribe = manager.subscribe((event) => {
      if (event.type === "closed") {
        closedTabIds.push(event.tabId);
      }
    });

    const first = yield* manager.open({ threadId, url: "localhost:5173" });
    const second = yield* manager.open({ threadId, url: "127.0.0.1:3000" });
    const other = yield* manager.open({ threadId: otherThreadId, url: "localhost:8080" });

    yield* manager.close({ threadId });

    const empty = yield* manager.list({ threadId });
    const otherList = yield* manager.list({ threadId: otherThreadId });
    assert.deepEqual(empty.sessions, []);
    assert.deepEqual(closedTabIds.toSorted(), [first.tabId, second.tabId].toSorted());
    assert.equal(otherList.sessions.length, 1);
    assert.equal(otherList.sessions[0]?.tabId, other.tabId);
    unsubscribe();
  }),
);
