import { expect, it } from "vitest";
import { collectComposerModelMentions } from "./composerModelMentions";
it("preserves slashes and balanced brackets while trimming prose punctuation", () => {
  const text = "(model:pi/openrouter/opus[1m]), model:work/gpt-6.1!";
  expect(collectComposerModelMentions(text).map((item) => item.raw)).toEqual([
    "model:pi/openrouter/opus[1m]",
    "model:work/gpt-6.1",
  ]);
  expect(collectComposerModelMentions("xmodel:a/b model:/bad")).toEqual([]);
});
