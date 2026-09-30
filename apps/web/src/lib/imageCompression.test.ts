import { expect, it } from "vitest";

import { processComposerImageBounded } from "./imageCompression";

it("releases a conversion slot when the processor throws synchronously", async () => {
  const file = new File(["x"], "photo.png", { type: "image/png" });
  const signal = new AbortController().signal;
  const throwing = () => {
    throw new Error("worker unavailable");
  };
  // More throwing jobs than slots: each must settle and hand its slot on.
  const results = await Promise.all(
    Array.from({ length: 4 }, () => processComposerImageBounded(throwing, file, signal)),
  );
  expect(results).toEqual(Array(4).fill({ ok: false, reason: "unreadable" }));

  const converted = await processComposerImageBounded(
    async (input) => ({
      ok: true,
      file: input,
      recompressed: false,
      originalSizeBytes: input.size,
      finalSizeBytes: input.size,
    }),
    file,
    signal,
  );
  expect(converted).toMatchObject({ ok: true });
});
