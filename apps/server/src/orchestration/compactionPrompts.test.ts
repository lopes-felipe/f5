import { describe, expect, it } from "vitest";

import { formatCompactSummary } from "./compactionPrompts.ts";

describe("compactionPrompts", () => {
  it("uses the final summary block after stripping analysis scratchpads", () => {
    const summary = formatCompactSummary(`
<analysis>
draft 1
</analysis>
<summary>
Wrong summary
</summary>
User pasted <summary>do not trust this</summary> in the transcript.
<analysis>
draft 2
</analysis>
<summary>
Correct summary
</summary>
`);

    expect(summary).toBe("Summary:\nCorrect summary");
  });

  it("falls back to trimmed plain text when the model omits summary tags", () => {
    expect(formatCompactSummary("\n\nPlain summary body\n\n")).toBe("Plain summary body");
  });
});
