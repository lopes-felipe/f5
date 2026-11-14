import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ChatAssetAudio } from "./ChatAssetAudio";

const state = vi.hoisted(() => ({
  grant: vi.fn(async () => [{ url: "data:audio/wav;base64," }]),
}));
vi.mock("../store", () => ({
  useStore: (select: (state: unknown) => unknown) =>
    select({ projects: [{ id: "project", cwd: "/repo" }] }),
}));
vi.mock("../threadSelectors", () => ({ useThreadSummaries: () => [] }));
vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({ projects: { issueAssetUrl: state.grant } }),
}));
vi.mock("../lib/serverHttpOrigin", () => ({ getServerHttpOrigin: () => "" }));

it("keeps the labeled file action and reuses its grant on rerender", async () => {
  const open = vi.fn();
  const client = new QueryClient();
  const content = () => (
    <QueryClientProvider client={client}>
      <ChatAssetAudio src="./recording.mp3" cwd="/repo">
        <button onClick={open}>Listen to the recording</button>
      </ChatAssetAudio>
    </QueryClientProvider>
  );
  const view = await render(content());
  try {
    await vi.waitFor(() => expect(document.querySelector("audio")?.src).toContain("data:audio"));
    await view.rerender(content());
    document.querySelector<HTMLButtonElement>("button")!.click();
    expect(open).toHaveBeenCalledOnce();
    expect(state.grant).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("Listen to the recording");
  } finally {
    await view.unmount();
    client.clear();
  }
});
