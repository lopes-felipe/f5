import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PullRequestKey, type NativeApi } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { setPrHubAccount } from "../../lib/prHubAccount";
import { PrChangeStat } from "./PrChangeStat";

const api = vi.hoisted(() => ({ getChangeBreakdown: vi.fn() }));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({ prHub: api }) as unknown as NativeApi,
}));
const pr = {
  key: PullRequestKey.makeUnsafe("github:github.com/o/r#12"),
  headRefOid: "head",
  additions: 3,
  deletions: 1,
};
const result = {
  headOid: "head",
  baseOid: "base",
  breakdown: {
    code: { additions: 3, deletions: 1 },
    tests: { additions: 0, deletions: 0 },
    mocks: { additions: 0, deletions: 0 },
    generated: { additions: 0, deletions: 0 },
    docs: { additions: 0, deletions: 0 },
  },
};
let active: Awaited<ReturnType<typeof render>> | undefined;
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  setPrHubAccount({ host: "github.com", viewerId: 1, generation: "stats-test" });
  api.getChangeBreakdown.mockResolvedValue(result);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await active?.unmount();
  client.clear();
});
async function mount(eager = false) {
  active = await render(
    <QueryClientProvider client={client}>
      <PrChangeStat pr={pr} eager={eager} />
    </QueryClientProvider>,
  );
  return document.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]')!;
}
it("keeps queue stats out of tab order and cancels short hovers", async () => {
  const trigger = await mount();
  expect(trigger.tabIndex).toBe(-1);
  trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  trigger.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
  trigger.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(api.getChangeBreakdown).not.toHaveBeenCalled();
  trigger.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
  await vi.waitFor(() => expect(api.getChangeBreakdown).toHaveBeenCalledTimes(1));
});
it.each(["head", "new-head"])(
  "shows only breakdowns for the displayed head: %s",
  async (headOid) => {
    api.getChangeBreakdown.mockResolvedValue({ ...result, headOid });
    const trigger = await mount(true);
    expect(trigger.tabIndex).toBe(0);
    trigger.focus();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
        headOid === "head" ? "code" : "Breakdown unavailable",
      ),
    );
  },
);
