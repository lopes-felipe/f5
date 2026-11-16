import { lazy, Suspense, useState, type ComponentProps } from "react";
import type { McpImportDialog as ImportComponent } from "./McpImportDialog";
import { Button } from "../../ui/button";

const ImportDialog = lazy(() =>
  import("./McpImportDialog").then((module) => ({ default: module.McpImportDialog })),
);

export function LazyMcpImportDialog(props: ComponentProps<typeof ImportComponent>) {
  const [opened, setOpened] = useState(false);
  return opened ? (
    <Suspense fallback={<p className="text-xs text-muted-foreground">Loading import…</p>}>
      <ImportDialog {...props} />
    </Suspense>
  ) : (
    <Button size="sm" variant="outline" onClick={() => setOpened(true)}>
      Import configuration
    </Button>
  );
}
