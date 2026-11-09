import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { AttachmentImage } from "./AttachmentImage";
import { decodeHeicPreview } from "../lib/heicPreview";

vi.mock("../lib/heicPreview", () => ({ decodeHeicPreview: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it("decodes failed HEIC images lazily and revokes the converted URL", async () => {
  const converted = new Blob(["jpeg"], { type: "image/jpeg" });
  const file = new File([converted], "photo.jpeg", { type: "image/jpeg" });
  vi.mocked(decodeHeicPreview).mockResolvedValue({
    ok: true,
    file,
    recompressed: true,
    originalSizeBytes: 4,
    finalSizeBytes: file.size,
  });
  const fetchImage = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(new Blob(["heic"])));
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:converted");
  const view = await render(
    <AttachmentImage src="http://localhost:4321/attachments/stored-heic" name="photo.heic" />,
  );
  try {
    const img = document.querySelector("img")!;
    img.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(img.getAttribute("src")).toBe("blob:converted"));
    expect(decodeHeicPreview).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(file);
    expect(fetchImage).toHaveBeenCalledWith("http://localhost:4321/attachments/stored-heic", {
      credentials: "include",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
  } finally {
    await view.unmount();
  }
  expect(revoke).toHaveBeenCalledWith("blob:converted");
});

it("uses retained source bytes instead of fetching a preview URL", async () => {
  const fetchImage = vi.spyOn(globalThis, "fetch");
  vi.mocked(decodeHeicPreview).mockResolvedValue({ ok: false, reason: "unreadable" });
  const sourceBlob = new Blob(["heic"], { type: "image/heic" });
  const view = await render(
    <AttachmentImage src="blob:retained" sourceBlob={sourceBlob} name="photo.heic" />,
  );
  try {
    document.querySelector("img")!.dispatchEvent(new Event("error"));
    await vi.waitFor(() =>
      expect(decodeHeicPreview).toHaveBeenCalledWith(
        sourceBlob,
        "photo.heic",
        expect.any(AbortSignal),
      ),
    );
    expect(fetchImage).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
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

it("discards conversion results after unmounting", async () => {
  let finish!: (value: Awaited<ReturnType<typeof decodeHeicPreview>>) => void;
  vi.mocked(decodeHeicPreview).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const create = vi.spyOn(URL, "createObjectURL");
  const sourceBlob = new Blob(["heic"], { type: "image/heic" });
  const view = await render(
    <AttachmentImage src="blob:pending" sourceBlob={sourceBlob} name="photo.heic" />,
  );
  document.querySelector("img")!.dispatchEvent(new Event("error"));
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const signal = vi.mocked(decodeHeicPreview).mock.calls.at(-1)![2];
  await view.unmount();
  expect(signal.aborted).toBe(true);
  finish({
    ok: true,
    file: new File(["jpeg"], "photo.jpeg"),
    recompressed: true,
    originalSizeBytes: 4,
    finalSizeBytes: 4,
  });
  await Promise.resolve();
  expect(create).not.toHaveBeenCalled();
});
