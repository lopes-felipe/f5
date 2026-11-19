import "../../index.css";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ThreadId, type TrackedPullRequest } from "@t3tools/contracts";
import { PrAddCommentToChat } from "./PrAddCommentToChat";
import { useActiveComposerSelection } from "../../activeComposerSelection";
import { useComposerDraftStore } from "../../composerDraftStore";
const api = vi.hoisted(() => ({ getThreadsForPr: vi.fn(), navigate: vi.fn() }));
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ prHub: api }) }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: api.navigate }) }));
it("appends neutral comment context to the adjacent composer", async () => {
  const threadId = ThreadId.makeUnsafe("comment-thread");
  useComposerDraftStore.getState().setPrompt(threadId, "My question");
  useActiveComposerSelection.setState({
    registrations: new Map([
      [
        Symbol(),
        {
          threadId,
          instanceId: null,
          provider: "codex",
          model: "model",
        },
      ],
    ]),
  });
  const screen = await render(
    <PrAddCommentToChat
      pr={{ title: "Test", url: "https://github.com/a/b/pull/1" } as TrackedPullRequest}
      body="Explain this"
    />,
  );
  try {
    await page.getByRole("button", { name: "Add to chat" }).click();
    const prompt = useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt;
    expect(prompt).toContain("My question");
    expect(prompt).toContain("Explain this");
    expect(prompt).not.toMatch(/fix|review this/i);
  } finally {
    await screen.unmount();
    useActiveComposerSelection.setState({ registrations: new Map() });
  }
});

it("offers a linked conversation when opened from the PR hub", async () => {
  const first = ThreadId.makeUnsafe("first-linked");
  const second = ThreadId.makeUnsafe("second-linked");
  useActiveComposerSelection.setState({ registrations: new Map() });
  api.getThreadsForPr.mockResolvedValue([
    { threadId: first, title: "First" },
    { threadId: second, title: "Second" },
  ]);
  const screen = await render(
    <PrAddCommentToChat
      pr={{ title: "Test", url: "https://github.com/a/b/pull/1" } as TrackedPullRequest}
      body="Explain this comment"
    />,
  );
  try {
    await page.getByRole("button", { name: "Add to chat" }).click();
    await page.getByRole("combobox", { name: "F5 thread for comment" }).selectOptions(second);
    await page.getByRole("button", { name: "Add to chat" }).click();
    expect(useComposerDraftStore.getState().draftsByThreadId[second]?.prompt).toContain(
      "Explain this comment",
    );
    expect(api.navigate).toHaveBeenCalledWith({ to: "/$threadId", params: { threadId: second } });
  } finally {
    await screen.unmount();
  }
});
