import type { ProjectId } from "@t3tools/contracts";
import { SCRATCH_PROJECT_TITLE } from "@t3tools/shared/scratchProject";
import { ChevronsUpDownIcon } from "lucide-react";
import { useState, type MouseEventHandler } from "react";

import { cn } from "../lib/utils";
import type { Project } from "../types";
import { COMPOSER_CHIP_CLASS_NAME } from "./chat/composer/composerChip";
import {
  HOME_PROJECT_TRIGGER_CLASS_NAME,
  HomeProjectTriggerContent,
  type HomeProjectSelection,
} from "./home/HomeProjectPickerPlaceholder";
import { ProjectIcon } from "./ProjectIcon";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";

export type ProjectPickerSelection = HomeProjectSelection;

/**
 * Where the picker sits: Home's quick start, a breadcrumb (chat header, dialog
 * header) or the composer footer. Only the trigger's look differs.
 */
export type ProjectPickerTrigger = "home" | "crumb" | "chip";

const NO_PROJECT_VALUE = "no-project";

const CRUMB_TRIGGER_CLASS_NAME =
  "flex min-w-0 max-w-44 shrink cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-ui text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground";

function ProjectPickerTriggerContent(props: {
  readonly trigger: ProjectPickerTrigger;
  readonly selection: ProjectPickerSelection | null;
  readonly project: Project | undefined;
}) {
  const none = props.selection?.kind === "none";
  if (props.trigger === "home") {
    return (
      <HomeProjectTriggerContent
        target={none ? { kind: "none" } : { kind: "project", project: props.project }}
      />
    );
  }
  const name = none ? SCRATCH_PROJECT_TITLE : props.project?.name;
  const iconClassName = props.trigger === "crumb" ? "size-4 shrink-0" : "size-3.5 shrink-0";
  return (
    <>
      {none ? (
        <ProjectIcon kind="scratch" name={SCRATCH_PROJECT_TITLE} className={iconClassName} />
      ) : props.project ? (
        <ProjectIcon
          projectId={props.project.id}
          kind={props.project.kind}
          name={props.project.name}
          icon={props.project.icon}
          className={iconClassName}
        />
      ) : null}
      <span className="min-w-0 truncate">{name ?? "Select project"}</span>
      <ChevronsUpDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
    </>
  );
}

/** Searchable project picker shared by Home, draft threads and the New Workflow dialog. */
export function ProjectPicker(props: {
  readonly projects: ReadonlyArray<Project>;
  readonly selection: ProjectPickerSelection | null;
  readonly onSelect: (selection: ProjectPickerSelection) => void;
  /** Adds the "No project" (scratch) row. */
  readonly allowNone: boolean;
  readonly trigger: ProjectPickerTrigger;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly onContextMenu?: MouseEventHandler<HTMLElement>;
}) {
  const [projectSearch, setProjectSearch] = useState("");
  const normalizedSearch = projectSearch.trim().toLowerCase();
  const filteredProjects = props.projects.filter((project) =>
    project.name.toLowerCase().includes(normalizedSearch),
  );
  const selectedProject = props.projects.find(
    (project) => props.selection?.kind === "project" && project.id === props.selection.projectId,
  );
  const none = { value: NO_PROJECT_VALUE, project: undefined };
  const projectOptions = filteredProjects.map((project) => ({
    value: project.id as string,
    project,
  }));
  const showNone =
    props.allowNone &&
    ["no project", "scratch", "without a project"].some((term) =>
      term.startsWith(normalizedSearch),
    );
  const options =
    normalizedSearch === "" && props.allowNone
      ? [none, ...projectOptions]
      : [...projectOptions, ...(showNone ? [none] : [])];
  const triggerLabel =
    props.selection?.kind === "none"
      ? `Project: ${SCRATCH_PROJECT_TITLE}`
      : selectedProject
        ? `Project: ${selectedProject.name}`
        : "Project";
  return (
    <Combobox
      // Explicit indices own item registration. Base UI's automatic collection
      // otherwise truncates its refs to zero because no items register in that map.
      virtualized
      items={options.map((option) => option.value)}
      filteredItems={options.map((option) => option.value)}
      value={
        props.selection?.kind === "none" ? NO_PROJECT_VALUE : (props.selection?.projectId ?? null)
      }
      autoHighlight
      disabled={props.disabled ?? false}
      onOpenChange={(open) => {
        if (!open) setProjectSearch("");
      }}
      onValueChange={(value) => {
        if (value)
          props.onSelect(
            value === NO_PROJECT_VALUE
              ? { kind: "none" }
              : { kind: "project", projectId: value as ProjectId },
          );
      }}
    >
      <ComboboxTrigger
        render={
          props.trigger === "crumb" ? (
            <button type="button" />
          ) : (
            <Button type="button" variant="ghost" size="sm" />
          )
        }
        aria-label={props.trigger === "home" ? "Project" : triggerLabel}
        data-project-picker={props.trigger}
        onContextMenu={props.onContextMenu}
        className={cn(
          props.trigger === "home"
            ? HOME_PROJECT_TRIGGER_CLASS_NAME
            : props.trigger === "crumb"
              ? CRUMB_TRIGGER_CLASS_NAME
              : cn(COMPOSER_CHIP_CLASS_NAME, "max-w-48"),
          props.className,
        )}
      >
        <ProjectPickerTriggerContent
          trigger={props.trigger}
          selection={props.selection}
          project={selectedProject}
        />
      </ComboboxTrigger>
      <ComboboxPopup className="w-72">
        <div className="border-b p-2">
          <ComboboxInput
            aria-label="Search projects"
            placeholder="Search projects…"
            showTrigger={false}
            value={projectSearch}
            onChange={(event) => setProjectSearch(event.target.value)}
          />
        </div>
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList className="max-h-64">
          {options.map(({ value, project }, index) => (
            <ComboboxItem
              key={value}
              index={index}
              value={value}
              data-testid={project ? undefined : "project-picker-no-project"}
            >
              <span className="inline-flex min-w-0 items-center gap-2">
                <ProjectIcon
                  {...(project
                    ? { projectId: project.id, kind: project.kind }
                    : { kind: "scratch" as const })}
                  name={project?.name ?? SCRATCH_PROJECT_TITLE}
                  icon={project?.icon}
                  className="size-3.5"
                />
                <span className="truncate">{project?.name ?? SCRATCH_PROJECT_TITLE}</span>
              </span>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
