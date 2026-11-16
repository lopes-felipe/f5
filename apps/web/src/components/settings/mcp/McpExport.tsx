import type { ProjectId } from "@t3tools/contracts";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";

export function McpExport({
  effectiveJson,
  selectedProject,
  isCopied,
  onCopy,
  handleExportJson,
}: {
  readonly effectiveJson: string;
  readonly selectedProject: { readonly id: ProjectId; readonly name: string } | null;
  readonly isCopied: boolean;
  readonly onCopy: () => void;
  readonly handleExportJson: () => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-background p-4">
      <p className="text-xs text-muted-foreground">Secret values are not included.</p>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">Effective JSON export</p>
          <p className="text-xs text-muted-foreground">
            Export the canonical merged JSON for the selected project in{" "}
            <code>{'{ "mcpServers": { ... } }'}</code> format.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={!effectiveJson}
            onClick={() => {
              if (!effectiveJson) {
                return;
              }
              onCopy();
            }}
          >
            {isCopied ? "Copied" : "Copy JSON"}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={!effectiveJson || !selectedProject}
            onClick={handleExportJson}
          >
            Export JSON
          </Button>
        </div>
      </div>
      {selectedProject && effectiveJson ? (
        <Textarea readOnly value={effectiveJson} className="min-h-44 font-mono text-xs" />
      ) : (
        <p className="rounded-lg border border-dashed border-border bg-card/40 px-3 py-4 text-xs text-muted-foreground">
          Select a project to resolve and export the effective merged MCP configuration.
        </p>
      )}
    </div>
  );
}
