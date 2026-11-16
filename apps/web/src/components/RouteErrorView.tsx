import { Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";

import { Button } from "./ui/button";
import { SidebarInset } from "./ui/sidebar";
import { SurfaceErrorFallback } from "./ui/SurfaceErrorBoundary";

/**
 * In-canvas fallback for a `_chat` child route. The `_chat` layout and its
 * sidebar stay mounted, so the user can move to another thread or page.
 */
export function RouteErrorView({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <SurfaceErrorFallback
        name={`route:${router.state.location.pathname}`}
        title="This page could not be displayed."
        error={error}
        reset={() => {
          void router.invalidate().then(reset);
        }}
        actions={
          <Button size="xs" variant="outline" render={<Link to="/" />}>
            Go Home
          </Button>
        }
      />
    </SidebarInset>
  );
}
