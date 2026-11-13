import { describe, expect, it } from "vitest";
import { resolveThreadRouteRenderState } from "./threadRoutes";

const unlisted = {
  startupReady: true,
  threadExists: false,
  draftThreadExists: false,
  detail: undefined,
  detailFetching: false,
};

describe("thread route resolution", () => {
  it("waits for detail and store hydration before opening an unlisted thread", () => {
    expect(resolveThreadRouteRenderState(unlisted)).toBe("loading");
    expect(resolveThreadRouteRenderState({ ...unlisted, detailFetching: true })).toBe("loading");
    const detail = { thread: { deletedAt: null, archivedAt: null } };
    expect(resolveThreadRouteRenderState({ ...unlisted, detail })).toBe("loading");
    expect(resolveThreadRouteRenderState({ ...unlisted, detail, threadExists: true })).toBe(
      "ready",
    );
  });

  it.each([
    null,
    { deletedAt: "2026-01-02T00:00:00Z", archivedAt: null },
    { deletedAt: null, archivedAt: "2026-01-02T00:00:00Z" },
  ])("redirects only after detail confirms absence or removal: %j", (thread) => {
    const detail = { thread };
    expect(resolveThreadRouteRenderState({ ...unlisted, detail })).toBe("missing");
    expect(resolveThreadRouteRenderState({ ...unlisted, detail, startupReady: false })).toBe(
      "loading",
    );
    expect(resolveThreadRouteRenderState({ ...unlisted, detail, detailFetching: true })).toBe(
      "loading",
    );
  });

  it("keeps existing server threads and drafts usable without waiting for detail", () => {
    expect(resolveThreadRouteRenderState({ ...unlisted, threadExists: true })).toBe("ready");
    expect(resolveThreadRouteRenderState({ ...unlisted, draftThreadExists: true })).toBe("ready");
  });

  it("does not infer absence from errors or older servers that omit metadata", () => {
    expect(resolveThreadRouteRenderState(unlisted)).toBe("loading");
    expect(resolveThreadRouteRenderState({ ...unlisted, detail: {} })).toBe("loading");
  });
});
