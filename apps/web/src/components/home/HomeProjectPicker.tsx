import type { ProjectId } from "@t3tools/contracts";
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
} from "./HomeProjectPickerPlaceholder";

/** Home's searchable project picker. It loads after the first paint to keep startup small. */
export default function HomeProjectPicker(props: {
  readonly projects: ReadonlyArray<Project>;
  readonly projectId: ProjectId | null;
  readonly onSelect: (projectId: ProjectId) => void;
}) {
  const [projectSearch, setProjectSearch] = useState("");
  const normalizedSearch = projectSearch.trim().toLowerCase();
  const filteredProjects = props.projects.filter((project) =>
    project.name.toLowerCase().includes(normalizedSearch),
  );
  const selectedProject = props.projects.find((project) => project.id === props.projectId);
  return (
    <Combobox
      items={props.projects.map((project) => project.id)}
      filteredItems={filteredProjects.map((project) => project.id)}
      value={props.projectId}
      autoHighlight
      onOpenChange={(open) => {
        if (!open) setProjectSearch("");
      }}
      onValueChange={(value) => {
        if (value) props.onSelect(value as ProjectId);
      }}
    >
      <ComboboxTrigger
        render={<Button type="button" variant="ghost" size="sm" />}
        aria-label="Project"
        className={HOME_PROJECT_TRIGGER_CLASS_NAME}
      >
        <HomeProjectTriggerContent project={selectedProject} />
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
          {filteredProjects.map((project, index) => (
            <ComboboxItem key={project.id} index={index} value={project.id}>
              <span className="inline-flex min-w-0 items-center gap-2">
                <ProjectIcon
                  projectId={project.id}
                  name={project.name}
                  icon={project.icon}
                  className="size-3.5"
                />
                <span className="truncate">{project.name}</span>
              </span>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
