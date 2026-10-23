import { Link } from "@tanstack/react-router";

import { buildAppSettingsPatch } from "../../../appSettings";
import { ProjectIcon } from "../../ProjectIcon";
import { useSettingsRouteContext } from "../SettingsRouteContext";
import { SettingsCard } from "../SettingsCard";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

export { PROJECTS_SETTINGS_DESCRIPTORS } from "./ProjectsSettings.descriptors";

const ADD_PROJECT_KEYS = ["addProjectBaseDirectory"] as const;

export function ProjectsSettings() {
  const { settings, defaults, updateSettings, projects, projectsHydrated } =
    useSettingsRouteContext();

  return (
    <>
      <SettingsCard
        title="Projects"
        searchTarget="projects.list"
        description="Configure a project to edit its icon and memory, and to override global settings for its threads."
      >
        {!projectsHydrated ? (
          <p className="text-xs text-muted-foreground">Loading projects…</p>
        ) : projects.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            No projects yet. Add one from the sidebar or the command palette.
          </p>
        ) : (
          <ul aria-label="Projects">
            {projects.map((project) => (
              <li
                key={project.id}
                className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <ProjectIcon
                    name={project.name}
                    projectId={project.id}
                    icon={project.icon}
                    className="size-6 shrink-0"
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{project.name}</p>
                    <p className="truncate font-mono text-2xs text-muted-foreground">
                      {project.cwd}
                    </p>
                  </div>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  className="shrink-0"
                  aria-label={`Configure ${project.name}`}
                  render={
                    <Link to="/settings" search={{ category: "project", project: project.id }} />
                  }
                >
                  Configure
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>

      <SettingsCard
        title="Add project"
        description={
          <>
            PR Hub looks for existing repositories directly inside this directory before asking you
            to select a folder. The command palette also starts here when adding a project. Leave
            blank to disable repository discovery and start from the server&rsquo;s home directory
            (when running remotely, this is the server account&rsquo;s home, not your local
            machine&rsquo;s).
          </>
        }
      >
        <div className="space-y-3">
          <label htmlFor="add-project-base-directory" className="block space-y-1">
            <span className="text-xs font-medium text-foreground">Base directory</span>
            <Input
              id="add-project-base-directory"
              className="font-mono"
              value={settings.addProjectBaseDirectory}
              onChange={(event) => updateSettings({ addProjectBaseDirectory: event.target.value })}
              placeholder="~/projects"
              spellCheck={false}
            />
            <span className="text-xs text-muted-foreground">
              Accepts <code>~/</code>, absolute, or Windows paths.
            </span>
          </label>
          {settings.addProjectBaseDirectory !== defaults.addProjectBaseDirectory ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => updateSettings(buildAppSettingsPatch(ADD_PROJECT_KEYS, defaults))}
            >
              Restore default
            </Button>
          ) : null}
        </div>
      </SettingsCard>

      <SettingsCard
        title="New projects"
        description="New project creates a folder here, initializes Git and makes a first commit. Leave blank to use f5-projects in your home folder (another profile gets its own folder)."
      >
        <div className="space-y-3">
          <label htmlFor="new-projects-root" className="block space-y-1">
            <span className="text-xs font-medium text-foreground">Projects folder</span>
            <Input
              id="new-projects-root"
              className="font-mono"
              value={settings.projectsRoot}
              onChange={(event) => updateSettings({ projectsRoot: event.target.value })}
              placeholder="~/f5-projects"
              spellCheck={false}
            />
          </label>
          {settings.projectsRoot !== defaults.projectsRoot ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => updateSettings({ projectsRoot: "" })}
            >
              Restore default
            </Button>
          ) : null}
        </div>
      </SettingsCard>
    </>
  );
}
