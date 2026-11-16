import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

// Lets components that render <Link> mount outside the app router in tests.
export function createTestRouter() {
  return createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute(),
  });
}

export function TestRouterContext({
  router,
  children,
}: {
  readonly router?: ReturnType<typeof createTestRouter>;
  readonly children: ReactNode;
}) {
  return (
    <RouterContextProvider router={router ?? createTestRouter()}>{children}</RouterContextProvider>
  );
}
