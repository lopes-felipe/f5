import { expect, it } from "vitest";
import { composerModelMentionItems } from "./composerModelMentions";
import { createTestServerProvider } from "../../testServerProvider";

it("matches model and provider word prefixes without flooding bare @ or file searches", () => {
  const provider = createTestServerProvider("pi", {
    displayName: "Local Ollama",
    models: Array.from({ length: 12 }, (_, index) => ({
      slug: "ollama/qwen-" + index,
      name: "Qwen " + index,
      capabilities: {},
      isCustom: false,
    })),
  });
  expect(composerModelMentionItems([provider], "")).toEqual([]);
  expect(composerModelMentionItems([provider], "q")).toEqual([]);
  expect(composerModelMentionItems([provider], "wen")).toEqual([]);
  expect(composerModelMentionItems([provider], "local:qw")).toHaveLength(8);
  expect(composerModelMentionItems([{ ...provider, enabled: false }], "qwen")).toEqual([]);
});
