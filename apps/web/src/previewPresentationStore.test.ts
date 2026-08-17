import { beforeEach, describe, expect, it } from "vitest";

import { usePreviewPresentationStore } from "./previewPresentationStore";

describe("preview presentation store", () => {
  beforeEach(() => {
    usePreviewPresentationStore.setState({ byThreadId: {} });
  });

  it("keeps page presentation isolated per thread and removes it on close", () => {
    const store = usePreviewPresentationStore.getState();
    store.set("thread-a" as never, {
      title: "F5 preview",
      url: "http://localhost:5173/",
      faviconDataUrl: "data:image/png;base64,iVBORw0KGgo=",
    });
    store.set("thread-b" as never, {
      title: "Docs",
      url: "http://localhost:3000/",
      faviconDataUrl: null,
    });

    expect(usePreviewPresentationStore.getState().byThreadId["thread-a"]?.title).toBe("F5 preview");
    store.remove("thread-a" as never);
    expect(usePreviewPresentationStore.getState().byThreadId["thread-a"]).toBeUndefined();
    expect(usePreviewPresentationStore.getState().byThreadId["thread-b"]?.title).toBe("Docs");
  });
});
