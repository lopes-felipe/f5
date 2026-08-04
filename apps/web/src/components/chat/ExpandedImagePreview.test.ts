import { describe, expect, it } from "vitest";

import {
  buildExpandedImagePreview,
  refreshExpandedImageActionSources,
} from "./ExpandedImagePreview";

describe("buildExpandedImagePreview", () => {
  it("keeps previewable images, MIME types, and the selected index", () => {
    expect(
      buildExpandedImagePreview(
        [
          {
            id: "missing",
            name: "missing.png",
            mimeType: "image/png",
          },
          {
            id: "first",
            name: "first.gif",
            mimeType: "image/gif",
            previewUrl: "blob:first",
            sourceUrl: "/attachments/first",
          },
          {
            id: "second",
            name: "second.webp",
            mimeType: "image/webp",
            previewUrl: "/attachments/second",
          },
        ],
        "second",
      ),
    ).toEqual({
      images: [
        {
          src: "/attachments/first",
          previewSrc: "blob:first",
          name: "first.gif",
          mimeType: "image/gif",
        },
        {
          src: "/attachments/second",
          previewSrc: "/attachments/second",
          name: "second.webp",
          mimeType: "image/webp",
        },
      ],
      index: 1,
    });
  });

  it("returns null when the selected image cannot be previewed", () => {
    expect(
      buildExpandedImagePreview(
        [
          {
            id: "missing",
            name: "missing.png",
            mimeType: "image/png",
          },
        ],
        "missing",
      ),
    ).toBeNull();
  });

  it("upgrades an already-open optimistic preview to use persisted bytes for actions", () => {
    const preview = buildExpandedImagePreview(
      [
        {
          id: "optimistic",
          name: "screenshot.png",
          mimeType: "image/png",
          previewUrl: "blob:optimistic-preview",
        },
      ],
      "optimistic",
    );
    expect(preview).not.toBeNull();

    expect(
      refreshExpandedImageActionSources(preview!, [
        {
          previewUrl: "blob:optimistic-preview",
          sourceUrl: "/attachments/persisted",
        },
      ]),
    ).toEqual({
      images: [
        {
          src: "/attachments/persisted",
          previewSrc: "blob:optimistic-preview",
          name: "screenshot.png",
          mimeType: "image/png",
        },
      ],
      index: 0,
    });
  });
});
