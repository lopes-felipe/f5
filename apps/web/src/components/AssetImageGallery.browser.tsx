import "../index.css";

import { useState } from "react";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AssetImageGallery, type AssetGalleryState } from "./AssetImageGallery";

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function Harness() {
  const [gallery, setGallery] = useState<AssetGalleryState | null>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => setGallery({ images: [{ src: PIXEL, name: "pixel.png" }], index: 0 })}
      >
        Open image
      </button>
      {gallery && (
        <AssetImageGallery
          gallery={gallery}
          onChange={setGallery}
          onClose={() => setGallery(null)}
        />
      )}
    </>
  );
}

it("returns focus to the element that opened the gallery when it closes", async () => {
  const view = await render(<Harness />);
  try {
    const opener = document.querySelector<HTMLButtonElement>("button")!;
    opener.focus();
    opener.click();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());

    const close = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Close",
    )!;
    close.click();

    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  } finally {
    await view.unmount();
  }
});
