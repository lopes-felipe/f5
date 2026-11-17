import "../../index.css";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { MessageId, ThreadId } from "@t3tools/contracts";
import { AssistantResponseCard } from "./AssistantResponseCard";

describe("sent response cards", () => {
  it("renders the selected passage and navigates to its source thread, not the side chat", async () => {
    const record = {
      version: 1 as const,
      kind: "quote" as const,
      threadId: ThreadId.make("parent"),
      messageId: MessageId.make("response"),
      text: "Highlighted passage",
      prefix: "Before. ",
      suffix: " After.",
    };
    const root = createRootRoute({
      component: () => (
        <>
          <AssistantResponseCard record={record} />
          <p>My comment</p>
        </>
      ),
    });
    const child = createRoute({ getParentRoute: () => root, path: "/$threadId" });
    const router = createRouter({
      routeTree: root.addChildren([child]),
      history: createMemoryHistory({ initialEntries: ["/side-chat"] }),
    });
    await router.load();
    const screen = await render(<RouterProvider router={router} />);
    try {
      const card = page.getByRole("link", { name: "Go to quoted response" });
      await expect.element(card).toHaveTextContent("Before. Highlighted passage After.");
      await expect.element(page.getByText("My comment")).toBeVisible();
      expect(document.querySelector("mark")?.textContent).toBe("Highlighted passage");
      expect(document.querySelector("[data-thread-find-ignore]")).not.toBeNull();
      await card.click();
      await expect.poll(() => router.state.location.pathname).toBe("/parent");
      expect(router.state.location.search).toMatchObject({
        timelineEntryId: "response",
        timelineEntryKind: "message",
      });
    } finally {
      await screen.unmount();
    }
  });
});
