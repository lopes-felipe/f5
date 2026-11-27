import type { McpCatalogDraft } from "@t3tools/shared/mcpCatalog";
import type { ComponentProps, ReactNode } from "react";

import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../../ui/dialog";
import { UnderlineTabs } from "../../ui/underline-tabs";
import { McpCatalogPanel } from "./McpCatalogPanel";
import { McpImportPanel } from "./McpImportPanel";

export type McpAddTab = "form" | "catalog" | "paste" | "import";

const TABS: ReadonlyArray<{ value: McpAddTab; label: string }> = [
  { value: "form", label: "Form" },
  { value: "catalog", label: "Catalog" },
  { value: "paste", label: "Paste JSON or TOML" },
  { value: "import", label: "Import" },
];

/**
 * Adds servers to the scope from a form, the MCP Registry catalog, pasted
 * configuration, or other clients' files.
 */
export function McpAddServerDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly tab: McpAddTab;
  readonly onTabChange: (tab: McpAddTab) => void;
  readonly scopeLabel: string;
  readonly title: string;
  /** The server form, owned by the page so its draft survives tab switches. */
  readonly form: ReactNode;
  readonly importProps: Omit<ComponentProps<typeof McpImportPanel>, "source">;
  /** Fills the form from a catalog entry and switches to it. */
  readonly onCatalogChoose: (draft: McpCatalogDraft) => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-2xl overflow-y-auto p-5">
        <DialogTitle>{props.title}</DialogTitle>
        <DialogDescription>Adds to {props.scopeLabel}.</DialogDescription>
        <UnderlineTabs
          aria-label="Add server from"
          className="my-3"
          tabs={TABS}
          value={props.tab}
          onValueChange={props.onTabChange}
        />
        {props.tab === "form" ? (
          props.form
        ) : props.tab === "catalog" ? (
          <McpCatalogPanel onChoose={props.onCatalogChoose} />
        ) : (
          <McpImportPanel
            key={props.tab}
            source={props.tab === "paste" ? "paste" : "detected"}
            {...props.importProps}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}
