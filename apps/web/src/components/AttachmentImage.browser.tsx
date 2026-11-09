import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { AttachmentImage } from "./AttachmentImage";
import { heicTo } from "heic-to/csp";

vi.mock("heic-to/csp", () => ({ heicTo: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it("decodes failed HEIC images lazily and revokes the converted URL", async () => {
  const converted = new Blob(["jpeg"], { type: "image/jpeg" });
  vi.mocked(heicTo).mockResolvedValue(converted);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Blob(["heic"])));
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:converted");
  const view = await render(<AttachmentImage src="data:image/heic,broken" name="photo.heic" />);
  try {
    const img = document.querySelector("img")!;
    img.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(img.getAttribute("src")).toBe("blob:converted"));
    expect(heicTo).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(converted);
  } finally {
    await view.unmount();
  }
  expect(revoke).toHaveBeenCalledWith("blob:converted");
});

it("forwards ordinary image errors without loading a decoder", async () => {
  const onError = vi.fn();
  const view = await render(
    <AttachmentImage src="data:image/png,broken" name="image.png" onError={onError} />,
  );
  try {
    document.querySelector("img")!.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
  } finally {
    await view.unmount();
  }
});
