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

it.each(["/work/pipeline.svg", "/work/diagram#v2.svg", "/work/diagram?v2.svg"])(
  "fits an SVG with no intrinsic dimensions using its file reference: %s",
  async (path) => {
    const src = URL.createObjectURL(
      new Blob(
        [
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1174 920"><rect width="1174" height="920"/></svg>',
        ],
        { type: "image/svg+xml" },
      ),
    );
    const view = await render(
      <AssetImageGallery
        gallery={{ images: [{ src, name: "Pipeline", path }], index: 0 }}
        onChange={() => {}}
        onClose={() => {}}
      />,
    );
    try {
      await vi.waitFor(() => {
        const image = document.querySelector<HTMLImageElement>('img[alt="Pipeline"]')!;
        expect(image.naturalWidth).toBeGreaterThan(0);
        const expected = Math.min(
          window.innerWidth * 0.92 - (window.innerWidth >= 640 ? 96 : 0),
          (window.innerHeight * 0.8 * image.naturalWidth) / image.naturalHeight,
        );
        expect(image.getBoundingClientRect().width).toBeCloseTo(expected, 0);
      });
    } finally {
      await view.unmount();
      URL.revokeObjectURL(src);
    }
  },
);

it("keeps raster images capped at their natural size", async () => {
  const view = await render(
    <AssetImageGallery
      gallery={{ images: [{ src: PIXEL, name: "pixel.png" }], index: 0 }}
      onChange={() => {}}
      onClose={() => {}}
    />,
  );
  try {
    await vi.waitFor(() => {
      const image = document.querySelector<HTMLImageElement>('img[alt="pixel.png"]')!;
      expect(image.naturalWidth).toBe(1);
      expect(image.getBoundingClientRect().width).toBe(1);
    });
  } finally {
    await view.unmount();
  }
});
