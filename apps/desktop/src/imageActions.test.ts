import * as Path from "node:path";

import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { readDesktopImageActionBytes, saveDesktopImageDownload } from "./imageActions";

describe("readDesktopImageActionBytes", () => {
  it("copies structured-clone byte views into main-process-owned storage", () => {
    const source = new Uint8Array([1, 2, 3]);
    const result = readDesktopImageActionBytes(source);

    source[0] = 9;
    expect(result).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects invalid, empty, and oversized payloads", () => {
    expect(() => readDesktopImageActionBytes("not bytes")).toThrow("invalid image bytes");
    expect(() => readDesktopImageActionBytes(new Uint8Array())).toThrow("attachment is empty");
    expect(() =>
      readDesktopImageActionBytes(new Uint8Array(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1)),
    ).toThrow("exceeds the desktop action size limit");
  });
});

describe("saveDesktopImageDownload", () => {
  it("writes original bytes exclusively into the Downloads directory", async () => {
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const bytes = new Uint8Array([71, 73, 70]);

    const savedPath = await saveDesktopImageDownload(
      {
        downloadsDirectory: "/Users/test/Downloads",
        filename: 'capture/one:"final".gif',
        bytes,
      },
      { mkdir, writeFile },
    );

    expect(savedPath).toBe(Path.join("/Users/test/Downloads", "capture_one__final_.gif"));
    expect(mkdir).toHaveBeenCalledWith("/Users/test/Downloads", { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(savedPath, bytes, { flag: "wx" });
  });

  it("adds a collision suffix without overwriting an existing download", async () => {
    const alreadyExists = Object.assign(new Error("exists"), { code: "EEXIST" });
    const writeFile = vi.fn().mockRejectedValueOnce(alreadyExists).mockResolvedValueOnce(undefined);

    const savedPath = await saveDesktopImageDownload(
      {
        downloadsDirectory: "/Users/test/Downloads",
        filename: "screen.png",
        bytes: new Uint8Array([1]),
      },
      { mkdir: vi.fn().mockResolvedValue(undefined), writeFile },
    );

    expect(savedPath).toBe(Path.join("/Users/test/Downloads", "screen (1).png"));
    expect(writeFile).toHaveBeenNthCalledWith(
      1,
      Path.join("/Users/test/Downloads", "screen.png"),
      new Uint8Array([1]),
      { flag: "wx" },
    );
    expect(writeFile).toHaveBeenNthCalledWith(
      2,
      Path.join("/Users/test/Downloads", "screen (1).png"),
      new Uint8Array([1]),
      { flag: "wx" },
    );
  });
});
