import { lazy, Suspense, type ComponentProps } from "react";
import type { McpServerInspector as InspectorComponent } from "./McpServerInspector";

const Inspector = lazy(() =>
  import("./McpServerInspector").then((module) => ({ default: module.McpServerInspector })),
);

export function LazyMcpServerInspector(props: ComponentProps<typeof InspectorComponent>) {
  return (
    <Suspense fallback={<p className="text-xs text-muted-foreground">Loading inspector…</p>}>
      <Inspector {...props} />
    </Suspense>
  );
}
