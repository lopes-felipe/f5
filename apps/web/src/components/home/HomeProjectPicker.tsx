import type { ProjectId } from "@t3tools/contracts";
import { SCRATCH_PROJECT_TITLE } from "@t3tools/shared/scratchProject";
import { useState } from "react";

import type { Project } from "../../types";
import { ProjectIcon } from "../ProjectIcon";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  HOME_PROJECT_TRIGGER_CLASS_NAME,
  HomeProjectTriggerContent,
  type HomeProjectSelection,
} from "./HomeProjectPickerPlaceholder";

const NO_PROJECT_VALUE = "no-project";
/** Home's searchable project picker. It loads after the first paint to keep startup small. */
export default function HomeProjectPicker(props: {
  readonly projects: ReadonlyArray<Project>;
  readonly selection: HomeProjectSelection | null;
  readonly onSelect: (selection: HomeProjectSelection) => void;
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
  const showNone = ["no project", "scratch", "without a project"].some((term) =>
    term.startsWith(normalizedSearch),
  );
  const options =
    normalizedSearch === ""
      ? [none, ...projectOptions]
      : [...projectOptions, ...(showNone ? [none] : [])];
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
        render={<Button type="button" variant="ghost" size="sm" />}
        aria-label="Project"
        className={HOME_PROJECT_TRIGGER_CLASS_NAME}
      >
        <HomeProjectTriggerContent
          target={
            props.selection?.kind === "none"
              ? { kind: "none" }
              : { kind: "project", project: selectedProject }
          }
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
              data-testid={project ? undefined : "home-picker-no-project"}
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
