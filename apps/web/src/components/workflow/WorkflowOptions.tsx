import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

/** Secondary workflow settings, collapsed until needed. */
export function WorkflowOptions(props: {
  readonly children: ReactNode;
  readonly summary?: string | undefined;
  readonly defaultOpen?: boolean | undefined;
}) {
  return (
    <Collapsible defaultOpen={props.defaultOpen ?? false} data-slot="workflow-options">
      <div className="rounded-lg border border-border">
        <CollapsibleTrigger className="group flex h-9 w-full items-center gap-2 rounded-lg px-3 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="text-ui font-medium text-foreground">Options</span>
          {props.summary ? (
            <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
              {props.summary}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <ChevronDownIcon
            aria-hidden="true"
            className="size-4 text-muted-foreground transition-transform duration-(--duration-fast) group-data-panel-open:rotate-180"
          />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
            {props.children}
          </div>
        </CollapsiblePanel>
      </div>
    </Collapsible>
  );
}

/** A labelled checkbox with a one-line explanation. */
export function WorkflowOptionCheckbox(props: {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly label: string;
  readonly description: ReactNode;
}) {
  return (
    <label className="flex items-start gap-2.5">
      <Checkbox
        checked={props.checked}
        onCheckedChange={(checked) => props.onCheckedChange(checked === true)}
        className="mt-0.5"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-ui font-medium text-foreground">{props.label}</span>
        <span className="text-ui text-muted-foreground">{props.description}</span>
      </span>
    </label>
  );
}

/** A labelled text field for an option (plans directory, compare branch, cost limit). */
export function WorkflowOptionField(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly hint?: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-ui font-medium text-foreground">{props.label}</span>
      {props.children}
      {props.hint ? <span className="text-2xs text-muted-foreground">{props.hint}</span> : null}
    </label>
  );
}

export const WORKFLOW_OPTION_INPUT_CLASS_NAME =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus-visible:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/20";
