import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { mcpQueryKeys } from "./mcpReactQuery";
import { useMcpStatusUpdates } from "./useMcpStatusUpdates";

const mocks = vi.hoisted(() => ({
  welcome: null as null | (() => void),
}));
vi.mock("../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nativeApi")>()),
  ensureNativeApi: () => ({ mcp: { onStatusUpdated: () => () => {} } }),
}));
vi.mock("../wsNativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wsNativeApi")>()),
  onServerWelcome: (listener: () => void) => {
    mocks.welcome = listener;
    // A welcome received before subscribing is replayed at once.
    listener();
    return () => {
      if (mocks.welcome === listener) mocks.welcome = null;
    };
  },
}));

function SignInStatus(props: { readonly read: () => Promise<string> }) {
  useMcpStatusUpdates();
  const status = useQuery({
    queryKey: [...mcpQueryKeys.all, "loginStatus", "test"],
    queryFn: props.read,
  });
  return <p>{status.data ?? "loading"}</p>;
}

describe("useMcpStatusUpdates", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("re-reads MCP queries after a reconnect but not for the welcome it subscribed after", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let reads = 0;
    const read = async () => {
      reads += 1;
      return reads === 1 ? "pending" : "signed-in";
    };
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <SignInStatus read={read} />
      </QueryClientProvider>,
    );
    try {
      await expect.element(screen.getByText("pending")).toBeVisible();
      expect(reads).toBe(1);
      // The socket reconnects: a status change pushed while it was down is picked up.
      mocks.welcome?.();
      await expect.element(screen.getByText("signed-in")).toBeVisible();
      expect(reads).toBe(2);
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
    expect(mocks.welcome).toBeNull();
  });
});
