import { describe, expect, it } from "vitest";

import { MAX_DOWNLOAD_FILENAME_CHARACTERS, sanitizeDownloadFilename } from "./downloadFilename";

describe("sanitizeDownloadFilename", () => {
  it("replaces unsafe characters and preserves useful extensions", () => {
    expect(sanitizeDownloadFilename('capture/one:"final".gif', "image")).toBe(
      "capture_one__final_.gif",
    );
    expect(sanitizeDownloadFilename(" ../shot?.png ", "image")).toBe(".._shot_.png");
    expect(sanitizeDownloadFilename("capture.png... ", "image")).toBe("capture.png");
  });

  it("uses a stable fallback for unusable names and prefixes Windows reserved names", () => {
    expect(sanitizeDownloadFilename("... ", "image")).toBe("image");
    expect(sanitizeDownloadFilename("\u0000\u001f", "image")).toBe("__");
    expect(sanitizeDownloadFilename("NUL.png", "image")).toBe("_NUL.png");
  });

  it("caps long names without dropping their extension", () => {
    const name = sanitizeDownloadFilename(`${"a".repeat(300)}.png`, "image");

    expect(Array.from(name)).toHaveLength(MAX_DOWNLOAD_FILENAME_CHARACTERS);
    expect(name.endsWith(".png")).toBe(true);
  });
});
