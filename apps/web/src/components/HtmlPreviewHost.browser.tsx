import { ThreadId, type HtmlPreviewHostRequest, type HtmlPreviewRequest } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { HtmlRenderThemeProvider, useHtmlRenderThemes } from "../hooks/useHtmlRenderTheme";
import { BUILTIN_THEME_PALETTES } from "../themePalette";
import { HtmlPreviewHost } from "./HtmlPreviewHost";

const host = vi.hoisted(() => ({
  listener: undefined as ((request: HtmlPreviewHostRequest) => void) | undefined,
  respond: vi.fn(async () => undefined),
  setHost: vi.fn(async () => undefined),
}));
vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    htmlRender: {
      setHost: host.setHost,
      respond: host.respond,
      onRequest: (listener: (request: HtmlPreviewHostRequest) => void) => {
        host.listener = listener;
        return () => undefined;
      },
    },
  }),
}));
vi.mock("../wsNativeApi", () => ({ onServerWelcome: () => () => undefined }));
vi.mock("../lib/serverHttpOrigin", () => ({ getServerHttpOrigin: () => "http://server.test" }));

afterEach(() => {
  delete window.desktopBridge;
  vi.restoreAllMocks();
});

it("renders each preview with the reader's theme for the appearance the agent asked for", async () => {
  const htmlPreview = vi.fn(async (_input: HtmlPreviewRequest) => ({
    _tag: "Unavailable" as const,
    message: "test",
  }));
  window.desktopBridge = { htmlPreview } as never;
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<p>Preview</p>"));
  let themes: ReturnType<typeof useHtmlRenderThemes> | undefined;
  const Capture = () => {
    themes = useHtmlRenderThemes();
    return null;
  };
  const palette = BUILTIN_THEME_PALETTES[0]!;
  const view = await render(
    <HtmlRenderThemeProvider
      palette={palette}
      settings={{ uiFontFamily: "", monoFontFamily: "" }}
      appearance="dark"
    >
      <Capture />
      <HtmlPreviewHost />
    </HtmlRenderThemeProvider>,
  );
  await expect.poll(() => host.listener).toBeDefined();
  host.listener!({
    requestId: "preview-1",
    threadId: ThreadId.makeUnsafe("thread"),
    width: 880,
    appearance: "light",
    documentPath: "/api/html-renders/preview/00000000-0000-0000-0000-000000000000",
  });
  await expect.poll(() => htmlPreview.mock.calls.length).toBe(1);
  expect(htmlPreview.mock.calls[0]![0]).toMatchObject({
    appearance: "light",
    html: "<p>Preview</p>",
    theme: themes!.light,
  });
  expect(themes!.appearance).toBe("dark");
  await view.unmount();
});
