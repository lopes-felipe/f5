import { PullRequestKey, type NativeApi, type TrackedPullRequest } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { setPrHubAccount } from "../../lib/prHubAccount";
import { usePrMarkSeen } from "./usePrMarkSeen";

const api = vi.hoisted(() => ({ markSeen: vi.fn() }));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({ prHub: api }) as unknown as NativeApi,
}));

const key = PullRequestKey.makeUnsafe("github:github.com/octo/repo#1");
const pr = (
  attentionFingerprint: string,
  changesSinceSeen: TrackedPullRequest["changesSinceSeen"],
) => ({ key, attentionFingerprint, changesSinceSeen }) as TrackedPullRequest;

function Seen({ value }: { value: TrackedPullRequest | null }) {
  usePrMarkSeen(value);
  return null;
}

/** Longer than the dwell before a visible pull request counts as seen. */
const dwell = () => new Promise((resolve) => setTimeout(resolve, 700));

beforeEach(() => {
  vi.clearAllMocks();
  api.markSeen.mockResolvedValue(undefined);
  setPrHubAccount({ host: "github.com", viewerId: 1, generation: "gen-1" });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("marks an open pull request seen once, and again only for new activity", async () => {
  const screen = await render(<Seen value={pr("fp-1", [{ kind: "comments", count: 2 }])} />);
  await expect.poll(() => api.markSeen.mock.calls.length).toBe(1);
  expect(api.markSeen).toHaveBeenLastCalledWith({
    key,
    attentionFingerprint: "fp-1",
    accountGeneration: "gen-1",
  });

  // The call cleared the changes. That is its own result, not something new to mark.
  await screen.rerender(<Seen value={pr("fp-1", [])} />);
  await dwell();
  expect(api.markSeen).toHaveBeenCalledTimes(1);

  // Activity that arrives while the pull request is open is seen as well.
  await screen.rerender(<Seen value={pr("fp-1", [{ kind: "commits" }])} />);
  await expect.poll(() => api.markSeen.mock.calls.length).toBe(2);

  // So is attention that changed without a listed change.
  await screen.rerender(<Seen value={pr("fp-2", [])} />);
  await expect.poll(() => api.markSeen.mock.calls.length).toBe(3);
  expect(api.markSeen).toHaveBeenLastCalledWith({
    key,
    attentionFingerprint: "fp-2",
    accountGeneration: "gen-1",
  });
  await screen.unmount();
});

it("tries again after a call that failed", async () => {
  api.markSeen.mockRejectedValueOnce(new Error("offline"));
  const screen = await render(<Seen value={pr("fp-1", [{ kind: "commits" }])} />);
  await expect.poll(() => api.markSeen.mock.calls.length).toBe(1);
  // Nothing was stored, so the same attention is sent again when the row is read anew.
  await screen.rerender(<Seen value={pr("fp-1", [{ kind: "commits" }, { kind: "ci_failed" }])} />);
  await expect.poll(() => api.markSeen.mock.calls.length).toBe(2);
  await screen.unmount();
});
