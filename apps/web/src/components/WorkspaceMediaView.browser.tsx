import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { WorkspaceMediaView } from "./WorkspaceMediaView";
import { applyWatchedPathsChanged } from "../lib/workspaceWatch";

const issueAssetUrl = vi.hoisted(() =>
  vi.fn(
    async (): Promise<Array<{ url: string; fileRevision: string } | null>> => [
      { url: "/api/workspace-assets/security-fixture/index.html", fileRevision: "one" },
    ],
  ),
);

vi.mock("../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nativeApi")>()),
  readNativeApi: () => ({
    projects: {
      issueAssetUrl,
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

it("keeps the same PDF document on grant renewal and reloads after an edit", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const cwd = "/workspace";
  const original = "/api/workspace-assets/original/document.pdf";
  const renewed = "/api/workspace-assets/renewed/document.pdf";
  const edited = "/api/workspace-assets/edited/document.pdf";
  issueAssetUrl
    .mockResolvedValueOnce([{ url: original, fileRevision: "one" }])
    .mockRejectedValueOnce(new Error("Disconnected"))
    .mockResolvedValueOnce([{ url: renewed, fileRevision: "one" }])
    .mockResolvedValueOnce([{ url: edited, fileRevision: "two" }])
    .mockResolvedValueOnce([null]);
  const view = await render(
    <QueryClientProvider client={client}>
      <WorkspaceMediaView name="document.pdf" cwd={cwd} projectId={"project" as never} />
    </QueryClientProvider>,
  );
  const frame = () => view.container.querySelector('iframe[title="document.pdf"]');
  try {
    await vi.waitFor(() => expect(frame()?.getAttribute("src")).toBe(location.origin + original));
    const opened = frame();
    await client.refetchQueries();
    await client.refetchQueries();
    expect(frame()).toBe(opened);
    expect(frame()?.getAttribute("src")).toBe(location.origin + original);
    applyWatchedPathsChanged(client, {
      cwd,
      degraded: false,
      changes: [{ relativePath: "document.pdf", kind: "file", change: "changed", revision: 1 }],
    });
    await vi.waitFor(() => expect(frame()?.getAttribute("src")).toBe(location.origin + edited));
    expect(frame()).not.toBe(opened);
    applyWatchedPathsChanged(client, {
      cwd,
      degraded: false,
      changes: [{ relativePath: "document.pdf", kind: "file", change: "deleted", revision: 2 }],
    });
    await vi.waitFor(() => {
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Unable to open this file",
      );
      expect(frame()).toBeNull();
    });
  } finally {
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
