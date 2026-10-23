import "../../index.css";
import { ThreadId } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "~/composerDraftStore";
import type { CreateProjectBackedDraftThreadOptions } from "~/hooks/useCreateProjectBackedDraftThread";

import { NewThreadLinkView } from "./NewThreadLinkView";

const threadId = ThreadId.makeUnsafe("routed-draft");
const api = vi.hoisted(() => ({
  server: { getConfig: vi.fn(async () => ({ providers: [] })) },
}));
vi.mock("~/lib/startupReady", () => ({ useStartupReady: () => true }));
vi.mock("~/wsConnectionState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/wsConnectionState")>()),
  useServerMutationsAvailable: () => true,
}));
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => api }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn(() => "toast"), close: vi.fn() } }));
// Behaves like the real hook: it opens the new draft through the router unless told not to,
// which unmounts the link view.
vi.mock("~/hooks/useStartScratchThread", () => ({
  useStartScratchThread: () => {
    const navigate = useNavigate();
    return async (options?: CreateProjectBackedDraftThreadOptions) => {
      if (options?.canNavigate?.() !== false)
        await navigate({ to: "/$threadId", params: { threadId } });
      return { threadId, projectId: "scratch" };
    };
  },
}));
afterEach(() => {
  useComposerDraftStore.setState({ draftsByThreadId: {} });
});

function ThreadDraft() {
  const { threadId } = useParams({ strict: false });
  const prompt = useComposerDraftStore(
    (store) => store.draftsByThreadId[ThreadId.makeUnsafe(threadId!)]?.prompt ?? "",
  );
  return <p data-testid="composer">{prompt}</p>;
}

it("opens the new thread with the linked prompt in its composer", async () => {
  const rootRoute = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/new",
        component: () => <NewThreadLinkView search="?prompt=Fix+the+build" />,
      }),
      createRoute({ getParentRoute: () => rootRoute, path: "/$threadId", component: ThreadDraft }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/new"] }),
  });
  const screen = await render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  await expect.element(screen.getByTestId("composer")).toHaveTextContent("Fix the build");
  expect(router.state.location.pathname).toBe(`/${threadId}`);
});
