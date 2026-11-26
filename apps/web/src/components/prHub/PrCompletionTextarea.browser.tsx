import "../../index.css";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import { PullRequestKey } from "@t3tools/contracts";
import { PrCompletionTextarea } from "./PrCompletionTextarea";

const completions = vi.hoisted(() =>
  vi.fn(async () => [
    { token: "@alice", label: "alice" },
    { token: "@alex", label: "alex" },
  ]),
);
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ prHub: { completions } }) }));
vi.mock("../../lib/prHubAccount", () => ({
  getPrHubAccountGeneration: () => "generation-1",
  usePrHubAccountSnapshot: () => ({ accountId: undefined, generation: "generation-1" }),
}));

function Composer() {
  const [value, setValue] = useState("Before  after");
  return (
    <PrCompletionTextarea
      prKey={PullRequestKey.makeUnsafe("github:repo:1")}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      aria-label="Draft"
    />
  );
}
it("navigates suggestions and inserts at the caret without removing the suffix", async () => {
  const screen = await render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer />
    </QueryClientProvider>,
  );
  const input = screen.getByRole("textbox", { name: "Draft" });
  await input.click();
  const element = document.querySelector("textarea")!;
  element.setSelectionRange(7, 7);
  await userEvent.keyboard("@al");
  await expect.element(screen.getByRole("listbox")).toBeVisible();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await vi.waitFor(() => expect(element.value).toBe("Before @alex after"));
  expect(element.selectionStart).toBe(12);
  expect(completions).toHaveBeenCalledWith(
    expect.objectContaining({ sigil: "@", query: "al", accountGeneration: "generation-1" }),
  );
  await screen.unmount();
});
it("Escape dismisses suggestions and preserves typed text", async () => {
  const screen = await render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer />
    </QueryClientProvider>,
  );
  await screen.getByRole("textbox", { name: "Draft" }).fill("@");
  await expect.element(screen.getByRole("listbox")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull());
  expect(document.querySelector("textarea")!.value).toBe("@");
  await screen.unmount();
});
