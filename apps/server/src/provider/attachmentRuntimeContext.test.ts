import { describe, expect, it } from "vitest";

import {
  appendProviderAttachmentRuntimeContext,
  buildProviderAttachmentRuntimeContext,
} from "./attachmentRuntimeContext.ts";

const attachment = {
  type: "image" as const,
  id: "thread-context-12345678-1234-1234-1234-123456789abc",
  name: "screen shot.png",
  mimeType: "image/png",
  sizeBytes: 4,
  localPath: "/tmp/f5/attachments/screen-shot.png",
};

describe("provider attachment runtime context", () => {
  it("describes the local path as best-effort sandbox access", () => {
    const context = buildProviderAttachmentRuntimeContext([attachment]);

    expect(context).toContain("best-effort access");
    expect(context).toContain("sandbox may prevent opening these paths");
    expect(context).toContain(JSON.stringify(attachment.name));
    expect(context).toContain(JSON.stringify(attachment.localPath));
  });

  it("does not alter prompts without resolved attachments", () => {
    expect(appendProviderAttachmentRuntimeContext("  hello  ", [])).toBe("  hello  ");
    expect(buildProviderAttachmentRuntimeContext([])).toBeUndefined();
  });

  it("keeps slash commands first when appending provider-only context", () => {
    const prompt = appendProviderAttachmentRuntimeContext("/plan investigate", [attachment]);

    expect(prompt?.startsWith("/plan investigate\n\n<f5-attachment-context>")).toBe(true);
  });
});
