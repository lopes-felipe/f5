import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { WorkspaceMediaView } from "./WorkspaceMediaView";

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    projects: {
      issueAssetUrl: async () => [{ url: "/api/workspace-assets/security-fixture/index.html" }],
    },
  }),
}));
vi.mock("../lib/serverHttpOrigin", () => ({ getServerHttpOrigin: () => window.location.origin }));

it("renders HTML in a sandbox and the production CSP blocks active content and exfiltration", async () => {
  const messages: string[] = [];
  const listener = (event: MessageEvent) => {
    if (event.data === "unsafe-script-executed") messages.push(event.data);
  };
  window.addEventListener("message", listener);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <WorkspaceMediaView name="index.html" identity={{ kind: "attachments" }} />
    </QueryClientProvider>,
  );
  try {
    await vi.waitFor(() =>
      expect(document.querySelector('iframe[title="index.html"]')).not.toBeNull(),
    );
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="index.html"]')!;
    expect(frame.getAttribute("sandbox")).toBe("");
    // Wait for the real document response and all its blocked subresource attempts.
    await new Promise<void>((resolve) => {
      frame.addEventListener("load", () => resolve(), { once: true });
      setTimeout(resolve, 1000);
    });
    expect(messages).toEqual([]);
    expect(await (await fetch("/__asset-security-count")).json()).toEqual({ attempts: 0 });
  } finally {
    window.removeEventListener("message", listener);
    await view.unmount();
    client.clear();
  }
});

it("keeps PDF in the native viewer and preserves the video element across rerenders", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renderMedia = (name: string) => (
    <QueryClientProvider client={client}>
      <WorkspaceMediaView name={name} identity={{ kind: "attachments" }} />
    </QueryClientProvider>
  );
  const view = await render(renderMedia("document.pdf"));
  try {
    await vi.waitFor(() =>
      expect(document.querySelector('iframe[title="document.pdf"]')).not.toBeNull(),
    );
    expect(document.querySelector('iframe[title="document.pdf"]')!.hasAttribute("sandbox")).toBe(
      false,
    );
    await view.rerender(renderMedia("movie.mp4"));
    await vi.waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    const video = document.querySelector("video")!;
    expect(video.controls).toBe(true);
    await view.rerender(renderMedia("movie.mp4"));
    expect(document.querySelector("video")).toBe(video);
  } finally {
    await view.unmount();
    client.clear();
  }
});
