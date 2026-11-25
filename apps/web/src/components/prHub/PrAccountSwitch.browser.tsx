import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PullRequestKey } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { setPrHubAccount, setPrHubSelectedAccountId } from "../../lib/prHubAccount";
import { PrAttentionNotificationControllerContent } from "./PrAttentionNotificationController";
import { PrReviewDraftEditor } from "./PrReviewDraftEditor";

const api = vi.hoisted(() => ({
  getOverview: vi.fn(),
  claimNotifications: vi.fn(),
  getReviewDraft: vi.fn(),
}));

vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ prHub: api }) }));
vi.mock("../../wsNativeApi", () => ({
  onPrHubChanged: () => () => {},
  onServerConfigUpdated: () => () => {},
  onServerWelcome: () => () => {},
}));

let active: Awaited<ReturnType<typeof render>> | undefined;
let client: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  setPrHubSelectedAccountId("acct-1");
  setPrHubAccount({ host: "github.com", viewerId: "1", generation: "gen-1" });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await active?.unmount();
  active = undefined;
  client.clear();
  setPrHubSelectedAccountId(undefined);
  setPrHubAccount(undefined);
});

it("switches PrAttentionNotificationController overview & claim requests after an account switch", async () => {
  api.getOverview.mockImplementation(async ({ accountId }: { accountId?: string }) => ({
    account: {
      host: "github.com",
      viewerId: accountId === "acct-2" ? "2" : "1",
      generation: accountId === "acct-2" ? "gen-2" : "gen-1",
    },
    revision: "rev-1",
  }));
  api.claimNotifications.mockImplementation(
    async ({ accountGeneration }: { accountGeneration: string }) => ({
      accountGeneration,
      items: [],
    }),
  );

  active = await render(
    <QueryClientProvider client={client}>
      <PrAttentionNotificationControllerContent navigateToPrHub={() => {}} />
    </QueryClientProvider>,
  );

  await expect
    .poll(() => api.getOverview.mock.calls.some(([arg]) => arg?.accountId === "acct-1"))
    .toBe(true);
  await expect
    .poll(() =>
      api.claimNotifications.mock.calls.some(([arg]) => arg?.accountGeneration === "gen-1"),
    )
    .toBe(true);

  setPrHubSelectedAccountId("acct-2");
  setPrHubAccount({ host: "github.com", viewerId: "2", generation: "gen-2" });

  await expect
    .poll(() => api.getOverview.mock.calls.some(([arg]) => arg?.accountId === "acct-2"))
    .toBe(true);
  await expect
    .poll(() =>
      api.claimNotifications.mock.calls.some(([arg]) => arg?.accountGeneration === "gen-2"),
    )
    .toBe(true);
});

it("re-queries PrReviewDraftEditor with the new accountGeneration on credential rotation", async () => {
  const prKey = PullRequestKey.makeUnsafe("github:github.com:org/repo:42");
  api.getReviewDraft.mockResolvedValue({ draft: null });

  active = await render(
    <QueryClientProvider client={client}>
      <PrReviewDraftEditor
        prKey={prKey}
        prUrl="https://github.com/org/repo/pull/42"
        comparison={{
          mode: "current_pr",
          baseRef: "main",
          baseOid: "base-1",
          baseRepository: "org/repo",
          headRef: "feature",
          headOid: "head-1",
          headRepository: "org/repo",
          mergeBaseOid: "base-1",
        }}
      />
    </QueryClientProvider>,
  );

  await expect
    .poll(() => api.getReviewDraft.mock.calls.some(([arg]) => arg?.accountGeneration === "gen-1"))
    .toBe(true);

  setPrHubAccount({ host: "github.com", viewerId: "1", generation: "gen-2" });

  await expect
    .poll(() => api.getReviewDraft.mock.calls.some(([arg]) => arg?.accountGeneration === "gen-2"))
    .toBe(true);
});
