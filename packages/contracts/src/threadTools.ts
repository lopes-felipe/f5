import { Schema } from "effect";
import { ThreadId } from "./baseSchemas";

export const HTML_RENDER_MAX_SOURCE_BYTES = 512 * 1024;
export const HTML_RENDER_MAX_PAGE_BYTES = 25 * 1024 * 1024;
const HtmlSource = Schema.String.check(Schema.isMaxLength(HTML_RENDER_MAX_SOURCE_BYTES));
export const HtmlRenderInput = Schema.Struct({
  html: HtmlSource,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  height: Schema.Int.check(Schema.isBetween({ minimum: 120, maximum: 2000 })),
});
export type HtmlRenderInput = typeof HtmlRenderInput.Type;
export const HtmlRenderReference = Schema.Struct({
  attachmentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  title: HtmlRenderInput.fields.title,
  height: HtmlRenderInput.fields.height,
});
export type HtmlRenderReference = typeof HtmlRenderReference.Type;
export const HtmlPreviewInput = Schema.Struct({
  html: HtmlSource,
  width: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 2000 }))),
  appearance: Schema.optional(Schema.Literals(["light", "dark"])),
});
export type HtmlPreviewInput = typeof HtmlPreviewInput.Type;
export const HtmlPreviewRequest = Schema.Struct({
  requestId: Schema.String.check(Schema.isMaxLength(100)),
  threadId: ThreadId,
  html: Schema.String.check(Schema.isMaxLength(HTML_RENDER_MAX_PAGE_BYTES)),
  width: Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 2000 })),
  appearance: Schema.Literals(["light", "dark"]),
});
export type HtmlPreviewRequest = typeof HtmlPreviewRequest.Type;
export const HtmlPreviewHostRequest = Schema.Struct({
  requestId: HtmlPreviewRequest.fields.requestId,
  threadId: ThreadId,
  width: HtmlPreviewRequest.fields.width,
  appearance: HtmlPreviewRequest.fields.appearance,
  documentPath: Schema.String.check(
    Schema.isPattern(/^\/api\/html-renders\/preview\/[a-f0-9-]{36}$/),
  ),
});
export type HtmlPreviewHostRequest = typeof HtmlPreviewHostRequest.Type;
export const HtmlPreviewResult = Schema.Union([
  Schema.TaggedStruct("Ready", {
    png: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(12 * 1024 * 1024)),
    width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2000 })),
    contentHeight: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
    capturedHeight: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2000 })),
    consoleMessages: Schema.Array(Schema.String.check(Schema.isMaxLength(1000))).check(
      Schema.isMaxLength(100),
    ),
  }),
  Schema.TaggedStruct("Unavailable", { message: Schema.String.check(Schema.isMaxLength(256)) }),
]);
export type HtmlPreviewResult = typeof HtmlPreviewResult.Type;
export const HtmlPreviewResponse = Schema.Struct({
  requestId: HtmlPreviewRequest.fields.requestId,
  result: HtmlPreviewResult,
});
export type HtmlPreviewResponse = typeof HtmlPreviewResponse.Type;
export const HtmlPreviewHostInput = Schema.Struct({ available: Schema.Boolean });
export const HTML_RENDER_WS_METHODS = {
  host: "htmlRender.host",
  respond: "htmlRender.respond",
} as const;
export const HTML_RENDER_REQUEST_CHANNEL = "htmlRender.request";
