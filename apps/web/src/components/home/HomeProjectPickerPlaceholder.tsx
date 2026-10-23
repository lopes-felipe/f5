import { ChevronsUpDownIcon } from "lucide-react";

import type { Project } from "../../types";
import { ProjectIcon } from "../ProjectIcon";
import { Button } from "../ui/button";

export const HOME_PROJECT_TRIGGER_CLASS_NAME =
  "h-7 max-w-56 gap-1.5 text-ui text-muted-foreground hover:text-foreground";

export function HomeProjectTriggerContent(props: { readonly project: Project | undefined }) {
  return (
    <>
      {props.project ? (
        <ProjectIcon
          projectId={props.project.id}
          name={props.project.name}
          icon={props.project.icon}
          className="size-3.5"
        />
      ) : null}
      <span className="truncate">{props.project?.name}</span>
      <ChevronsUpDownIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
    </>
  );
}

/** Shown while the picker loads; it looks the same, so Home does not shift. */
export function HomeProjectPickerPlaceholder(props: { readonly project: Project | undefined }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label="Project"
      className={HOME_PROJECT_TRIGGER_CLASS_NAME}
    >
      <HomeProjectTriggerContent project={props.project} />
    </Button>
  );
}
