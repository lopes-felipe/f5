import { describe, expect, it } from "vitest";
import { promptLinkScheme, threadLinkFor } from "./copyPromptLink";
import { threadIdOfThreadReferenceUrl } from "@t3tools/shared/threadReferences";

describe("threadLinkFor", () => {
  it("produces a thread link that can be opened and pasted back", () => {
    const id = "thread-123_abc";
    const link = threadLinkFor(id);
    expect(link).toBe(`${promptLinkScheme}://thread/${id}`);
    expect(threadIdOfThreadReferenceUrl(link)).toBe(id);
  });
  it.each(["../thread", "with space", "with?query", "settings", "x".repeat(129)])(
    "falls back to the raw id when it cannot form a thread link: %s",
    (id) => expect(threadLinkFor(id)).toBe(id),
  );
});
