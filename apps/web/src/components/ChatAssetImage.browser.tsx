import "../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ChatAssetImage } from "./ChatAssetImage";

const state = vi.hoisted(() => ({ url: "", issue: vi.fn() }));
vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({ projects: { issueAssetUrl: state.issue } }),
}));
vi.mock("../lib/serverHttpOrigin", () => ({ getServerHttpOrigin: () => "" }));
vi.mock("../store", () => ({
  useStore: (select: (value: unknown) => unknown) => select({ projects: [] }),
}));
vi.mock("../threadSelectors", () => ({ useThreadSummaries: () => [] }));
vi.mock("../appSettings", () => ({ useAppSettingsSelector: () => false }));

afterEach(() => {
  state.issue.mockReset();
  document.body.innerHTML = "";
  if (state.url) URL.revokeObjectURL(state.url);
});

const testQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function ImageFixture({ src, client = testQueryClient() }: { src: string; client?: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <ChatAssetImage src={src} alt="Capture" cwd="/workspace" />
    </QueryClientProvider>
  );
}

async function renderableImageUrl() {
  const canvas = document.createElement("canvas");
  canvas.width = 240;
  canvas.height = 120;
  canvas.getContext("2d")!.fillRect(0, 0, 240, 120);
  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((blob) => resolve(blob!), "image/png"),
  );
  return URL.createObjectURL(blob);
}

it("distinguishes inaccessible paths from loading without requesting a file", async () => {
  const view = await render(<ImageFixture src="/tmp/capture.png" />);
  try {
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Image outside available directories");
    expect(state.issue).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("loading");
  } finally {
    await view.unmount();
  }
});

it.each(["http://example.com/capture.png", "data:image/png;base64,AAAA", "blob:capture"])(
  "reports %s as an unsupported source rather than a directory problem",
  async (src) => {
    const view = await render(<ImageFixture src={src} />);
    try {
      await expect.element(page.getByRole("alert")).toHaveTextContent("Unsupported image source");
      expect(document.body.textContent).not.toContain("outside available directories");
      expect(state.issue).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  },
);

it("keeps loading placeholders out of live regions", async () => {
  state.issue.mockImplementation(() => new Promise(() => {}));
  const src = "/state/attachments/thread-1-12345678-1234-1234-1234-123456789abc.png";
  const view = await render(<ImageFixture src={src} />);
  try {
    await vi.waitFor(() => expect(document.body.textContent).toContain("(loading…)"));
    expect(document.querySelector('[role="status"], [role="alert"]')).toBeNull();
  } finally {
    await view.unmount();
  }
});

it("shows, expands and reloads a published screenshot after reopening", async () => {
  state.url = await renderableImageUrl();
  state.issue.mockImplementation(async () => [{ url: state.url, width: 240, height: 120 }]);
  const src = "/state/attachments/thread-1-12345678-1234-1234-1234-123456789abc.png";
  for (let opened = 0; opened < 2; opened++) {
    const view = await render(<ImageFixture src={src} />);
    try {
      await expect.element(page.getByRole("button", { name: "Preview Capture" })).toBeVisible();
      await vi.waitFor(() =>
        expect(document.querySelector<HTMLImageElement>("img[data-chat-asset]")?.naturalWidth).toBe(
          240,
        ),
      );
      await page.getByRole("button", { name: "Preview Capture" }).click();
      await expect.element(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      await expect.element(page.getByLabelText("Image zoom")).toHaveTextContent("150%");
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    } finally {
      await view.unmount();
    }
  }
  expect(state.issue).toHaveBeenCalledTimes(2);
  expect(state.issue.mock.calls[0]?.[0]).toMatchObject({ identity: { kind: "attachments" } });
});

it("keeps a loaded image when a background grant refresh fails", async () => {
  state.url = await renderableImageUrl();
  state.issue.mockImplementation(async () => [{ url: state.url, width: 240, height: 120 }]);
  const client = testQueryClient();
  const view = await render(
    <ImageFixture
      src="/state/attachments/thread-1-12345678-1234-1234-1234-123456789abc.png"
      client={client}
    />,
  );
  try {
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLImageElement>("img[data-chat-asset]")?.naturalWidth).toBe(
        240,
      ),
    );
    state.issue.mockRejectedValue(new Error("Grant refresh failed"));
    await client.refetchQueries({ queryKey: ["chat-asset"] });
    // The disabled pre-visibility query (no target yet) shares the prefix.
    const grant = client
      .getQueryCache()
      .findAll({ queryKey: ["chat-asset"] })
      .find((query) => query.queryKey[1] !== undefined);
    expect(grant?.state.status).toBe("error");
    // Let React render the failed query before checking that nothing was replaced.
    for (let frame = 0; frame < 3; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    await expect.element(page.getByRole("button", { name: "Preview Capture" })).toBeVisible();
    expect(page.getByRole("alert").query()).toBeNull();
  } finally {
    await view.unmount();
  }
});

it("reports a failed image download instead of leaving a broken preview", async () => {
  state.issue.mockResolvedValue([{ url: "data:image/png;base64,broken" }]);
  const view = await render(
    <ImageFixture src="/state/attachments/thread-1-12345678-1234-1234-1234-123456789abc.png" />,
  );
  try {
    await expect.element(page.getByRole("alert")).toHaveTextContent("Image unavailable");
    await expect
      .element(page.getByRole("button", { name: "Preview Capture" }))
      .not.toBeInTheDocument();
  } finally {
    await view.unmount();
  }
});
