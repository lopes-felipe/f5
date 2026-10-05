import { ChevronDownIcon, CircleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

export interface WorkflowStepError {
  readonly key: string;
  readonly step: string;
  readonly message: string;
}

/** Failed steps first, so a stuck run explains itself above everything else. */
export function WorkflowFailedSteps(props: { readonly errors: ReadonlyArray<WorkflowStepError> }) {
  if (props.errors.length === 0) return null;
  return (
    <Alert variant="error" data-slot="workflow-failed-steps">
      <CircleAlertIcon />
      <AlertTitle>Failed steps</AlertTitle>
      <AlertDescription>
        <ul className="mt-1 flex flex-col gap-2">
          {props.errors.map((error) => (
            <li key={error.key}>
              <p className="text-ui font-medium text-foreground">{error.step}</p>
              <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">
                {error.message}
              </p>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/** The run's input (requirement, brief, review instructions, problem), collapsible. */
export function WorkflowInputSection(props: {
  readonly label: string;
  readonly text: string;
  readonly defaultOpen: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={props.defaultOpen} data-slot="workflow-input">
      <section className="rounded-xl border border-border bg-card">
        {/* The heading wraps the trigger: a button may only hold phrasing content. */}
        <h2 className="text-sm font-semibold text-foreground">
          <CollapsibleTrigger className="group flex h-10 w-full items-center gap-2 rounded-xl px-4 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="flex-1">{props.label}</span>
            <ChevronDownIcon
              aria-hidden="true"
              className="size-4 text-muted-foreground transition-transform duration-(--duration-fast) group-data-panel-open:rotate-180"
            />
          </CollapsibleTrigger>
        </h2>
        <CollapsiblePanel>
          <div className="border-t border-border px-4 py-3">
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{props.text}</p>
            {props.children}
          </div>
        </CollapsiblePanel>
      </section>
    </Collapsible>
  );
}

/** A produced artifact (merged plan, document, review, RCA) with its actions. */
export function WorkflowArtifactSection(props: {
  readonly title: string;
  readonly actions?: ReactNode;
  readonly note?: ReactNode;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section
      data-slot="workflow-artifact"
      className={cn("rounded-xl border border-border bg-card", props.className)}
    >
      <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <h2 className="me-auto text-sm font-semibold text-foreground">{props.title}</h2>
        {props.actions}
      </div>
      <div className="px-4 py-4">
        {props.note}
        {props.children}
      </div>
    </section>
  );
}
