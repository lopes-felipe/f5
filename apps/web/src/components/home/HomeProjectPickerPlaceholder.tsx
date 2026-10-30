import { ChevronsUpDownIcon } from "lucide-react";
import type { ProjectId } from "@t3tools/contracts";
import { SCRATCH_PROJECT_TITLE } from "@t3tools/shared/scratchProject";

import type { Project } from "../../types";
import { ProjectIcon } from "../ProjectIcon";
import { Button } from "../ui/button";

export const HOME_PROJECT_TRIGGER_CLASS_NAME =
  "h-7 max-w-56 gap-1.5 text-ui text-muted-foreground hover:text-foreground";

export type HomeProjectSelection = { kind: "project"; projectId: ProjectId } | { kind: "none" };

export type HomeProjectTarget =
  | { kind: "project"; project: Project | undefined }
  | { kind: "none" };

export function HomeProjectTriggerContent({ target }: { readonly target: HomeProjectTarget }) {
  const project = target.kind === "project" ? target.project : undefined;
  return (
    <>
      {target.kind === "none" ? (
        <ProjectIcon kind="scratch" className="size-3.5" />
      ) : project ? (
        <ProjectIcon
          projectId={project.id}
          kind={project.kind}
          name={project.name}
          icon={project.icon}
          className="size-3.5"
        />
      ) : null}
      <span className="truncate">
        {target.kind === "none" ? SCRATCH_PROJECT_TITLE : project?.name}
      </span>
      <ChevronsUpDownIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
    </>
  );
}

/** Shown while the picker loads; it looks the same, so Home does not shift. */
export function HomeProjectPickerPlaceholder(props: { readonly target: HomeProjectTarget }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label="Project"
      className={HOME_PROJECT_TRIGGER_CLASS_NAME}
    >
      <HomeProjectTriggerContent target={props.target} />
    </Button>
  );
}
