import {
  PROJECT_ICON_COLORS,
  PROJECT_ICON_GLYPHS,
  type ProjectIconColor,
  type ProjectIconGlyph,
  type ProjectId,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  CLAUDE_SUBAGENT_MODEL_INHERIT,
  DEFAULT_CLAUDE_PROJECT_SETTINGS,
  buildAppSettingsPatch,
} from "../../../appSettings";
import { useSettingsRouteContext } from "../SettingsRouteContext";
import { projectCheckedInConfigQueryOptions } from "../../../lib/projectConfigReactQuery";
import { EMPTY_MEMORY_DRAFT, PROJECT_MEMORY_TYPES } from "../useSettingsRouteState";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Textarea } from "../../ui/textarea";
import { ProjectIcon } from "../../ProjectIcon";

export { PROJECTS_SETTINGS_DESCRIPTORS } from "./ProjectsSettings.descriptors";

const ADD_PROJECT_KEYS = ["addProjectBaseDirectory"] as const;

const PROJECT_ICON_GLYPH_LABELS: Readonly<Record<ProjectIconGlyph, string>> = {
  folder: "Folder",
  code: "Code",
  terminal: "Terminal",
  bot: "Bot",
  rocket: "Rocket",
  flask: "Flask",
  database: "Database",
  globe: "Globe",
  briefcase: "Briefcase",
  gamepad: "Gamepad",
};

function labelProjectIconColor(color: ProjectIconColor): string {
  return color.charAt(0).toUpperCase() + color.slice(1);
}

function CheckedInProjectConfigSummary({ projectId }: { readonly projectId: ProjectId }) {
  const configQuery = useQuery(projectCheckedInConfigQueryOptions(projectId));
  if (configQuery.isPending) {
    return <p className="text-xs text-muted-foreground">Checking f5.json…</p>;
  }
  if (configQuery.isError) {
    return (
      <p className="text-xs text-destructive">
        Could not inspect the checked-in project configuration.
      </p>
    );
  }

  const config = configQuery.data;
  const diagnostics = config.diagnostics ?? [];
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      <p>
        {config.sourceFile
          ? `Loaded non-executable defaults from ${config.sourceFile}.`
          : "No f5.json or compatible t3.json file was found."}
      </p>
      {config.defaultThreadEnvMode ? (
        <p>
          File workspace default: <span className="font-medium">{config.defaultThreadEnvMode}</span>
        </p>
      ) : null}
      {config.iconPath ? (
        <p>
          File icon: <span className="font-mono">{config.iconPath}</span>
        </p>
      ) : null}
      {diagnostics.length > 0 ? (
        <ul className="space-y-1 text-amber-700 dark:text-amber-300">
          {diagnostics.map((diagnostic, index) => (
            <li key={`${diagnostic.field}:${index}`}>
              <span className="font-medium">{diagnostic.field}:</span> {diagnostic.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ProjectsSettings() {
  const {
    settings,
    defaults,
    updateSettings,
    projects,
    hasProjects,
    selectedProject,
    selectedProjectUnavailable,
    handleSelectedProjectChange,
    selectedProjectMemories,
    projectMetadataPending,
    projectMetadataError,
    updateSelectedProjectMetadata,
    selectedProjectClaudeSettings,
    effectiveClaudeSubagentModel,
    claudeSubagentModelOptions,
    selectedClaudeSubagentModelLabel,
    updateSelectedProjectClaudeSettings,
    memoryDraft,
    setMemoryDraft,
    createMemoryError,
    setCreateMemoryError,
    editingMemoryId,
    setEditingMemoryId,
    editingMemoryDraft,
    setEditingMemoryDraft,
    existingMemoryError,
    setExistingMemoryError,
    memoryActionPendingId,
    submitMemoryCreate,
    submitMemoryUpdate,
    deleteMemory,
  } = useSettingsRouteContext();
  const [emojiDraft, setEmojiDraft] = useState("");

  useEffect(() => {
    setEmojiDraft(selectedProject?.icon?.type === "emoji" ? selectedProject.icon.emoji : "");
  }, [selectedProject?.icon, selectedProject?.id]);

  return (
    <>
      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4">
          <h2 className="text-sm font-medium text-foreground">Project context</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Select the active project for project-scoped settings like memory and MCP.
          </p>
        </div>

        {hasProjects ? (
          <label className="block space-y-2">
            <span className="text-xs font-medium text-foreground">Project</span>
            <Select
              value={selectedProject?.id ?? ""}
              onValueChange={(value) =>
                handleSelectedProjectChange(value ? (value as ProjectId) : null)
              }
            >
              <SelectTrigger aria-label="Settings project">
                <SelectValue>
                  {selectedProjectUnavailable
                    ? "Unavailable project"
                    : (selectedProject?.name ?? "Select a project")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {selectedProjectUnavailable ? (
              <span className="block rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                This project is unavailable or was deleted. Choose another project before editing
                project-scoped settings.
              </span>
            ) : null}
          </label>
        ) : selectedProjectUnavailable ? (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            This project is unavailable or was deleted. Open another project before editing
            project-scoped settings.
          </p>
        ) : (
          <p className="rounded-lg border border-dashed border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            Create a project first to configure project-scoped settings.
          </p>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4">
          <h2 className="text-sm font-medium text-foreground">Project defaults and icon</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Local overrides take priority over checked-in project defaults. Repository files may
            provide only non-executable workspace and icon settings.
          </p>
        </div>

        {selectedProject ? (
          <div className="space-y-4">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-foreground">Default workspace mode</span>
              <Select
                value={selectedProject.defaultEnvMode ?? "global"}
                onValueChange={(value) => {
                  if (value !== "global" && value !== "local" && value !== "worktree") return;
                  void updateSelectedProjectMetadata({
                    defaultEnvMode: value === "global" ? null : value,
                  });
                }}
                disabled={projectMetadataPending}
              >
                <SelectTrigger aria-label="Project default workspace mode">
                  <SelectValue>
                    {selectedProject.defaultEnvMode === "local"
                      ? "Local"
                      : selectedProject.defaultEnvMode === "worktree"
                        ? "Worktree"
                        : "Use global or checked-in default"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="global">Use global or checked-in default</SelectItem>
                  <SelectItem value="local">Local</SelectItem>
                  <SelectItem value="worktree">Worktree</SelectItem>
                </SelectPopup>
              </Select>
            </label>

            <div className="space-y-3" data-settings-search-target="projects.icon">
              <div className="flex items-center gap-3">
                <ProjectIcon
                  projectId={selectedProject.id}
                  icon={selectedProject.icon}
                  className="size-8"
                />
                <label className="min-w-0 flex-1 space-y-1">
                  <span className="text-xs font-medium text-foreground">Project icon</span>
                  <Select
                    value={selectedProject.icon?.type ?? "automatic"}
                    onValueChange={(value) => {
                      if (value === "automatic") {
                        void updateSelectedProjectMetadata({ icon: null });
                      } else if (value === "emoji") {
                        void updateSelectedProjectMetadata({
                          icon: { type: "emoji", emoji: emojiDraft.trim() || "📁" },
                        });
                      } else if (value === "lucide") {
                        void updateSelectedProjectMetadata({
                          icon: { type: "lucide", glyph: "folder", color: "gray" },
                        });
                      }
                    }}
                    disabled={projectMetadataPending}
                  >
                    <SelectTrigger aria-label="Project icon source">
                      <SelectValue>
                        {selectedProject.icon?.type === "emoji"
                          ? "Emoji"
                          : selectedProject.icon?.type === "lucide"
                            ? "Symbol"
                            : "Automatic"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="automatic">Automatic</SelectItem>
                      <SelectItem value="emoji">Emoji</SelectItem>
                      <SelectItem value="lucide">Symbol</SelectItem>
                    </SelectPopup>
                  </Select>
                </label>
              </div>

              {selectedProject.icon?.type === "emoji" ? (
                <div className="flex gap-2">
                  <Input
                    aria-label="Project icon emoji"
                    value={emojiDraft}
                    onChange={(event) => setEmojiDraft(event.target.value)}
                    maxLength={16}
                    placeholder="📁"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={projectMetadataPending || emojiDraft.trim().length === 0}
                    onClick={() =>
                      void updateSelectedProjectMetadata({
                        icon: { type: "emoji", emoji: emojiDraft.trim() },
                      })
                    }
                  >
                    Save emoji
                  </Button>
                </div>
              ) : null}

              {selectedProject.icon?.type === "lucide" ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Select
                    value={selectedProject.icon.glyph}
                    onValueChange={(value) => {
                      if (!PROJECT_ICON_GLYPHS.includes(value as ProjectIconGlyph)) return;
                      void updateSelectedProjectMetadata({
                        icon: {
                          type: "lucide",
                          glyph: value as ProjectIconGlyph,
                          color:
                            selectedProject.icon?.type === "lucide"
                              ? selectedProject.icon.color
                              : "gray",
                        },
                      });
                    }}
                    disabled={projectMetadataPending}
                  >
                    <SelectTrigger aria-label="Project icon symbol">
                      <SelectValue>
                        {PROJECT_ICON_GLYPH_LABELS[selectedProject.icon.glyph]}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {PROJECT_ICON_GLYPHS.map((glyph) => (
                        <SelectItem key={glyph} value={glyph}>
                          {PROJECT_ICON_GLYPH_LABELS[glyph]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <Select
                    value={selectedProject.icon.color}
                    onValueChange={(value) => {
                      if (!PROJECT_ICON_COLORS.includes(value as ProjectIconColor)) return;
                      void updateSelectedProjectMetadata({
                        icon: {
                          type: "lucide",
                          glyph:
                            selectedProject.icon?.type === "lucide"
                              ? selectedProject.icon.glyph
                              : "folder",
                          color: value as ProjectIconColor,
                        },
                      });
                    }}
                    disabled={projectMetadataPending}
                  >
                    <SelectTrigger aria-label="Project icon color">
                      <SelectValue>{labelProjectIconColor(selectedProject.icon.color)}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {PROJECT_ICON_COLORS.map((color) => (
                        <SelectItem key={color} value={color}>
                          {labelProjectIconColor(color)}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}
            </div>

            {projectMetadataError ? (
              <p className="text-xs text-destructive">{projectMetadataError}</p>
            ) : null}

            <div className="rounded-lg border border-border bg-background p-3">
              <p className="mb-2 text-xs font-medium text-foreground">Checked-in configuration</p>
              <CheckedInProjectConfigSummary projectId={selectedProject.id} />
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Select an available project to configure its workspace default and icon.
          </p>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4">
          <h2 className="text-sm font-medium text-foreground">Add project</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            The command palette opens this directory when you start adding a project. Leave blank to
            start from the server&rsquo;s home directory (when running remotely, this is the server
            account&rsquo;s home, not your local machine&rsquo;s).
          </p>
        </div>
        <div className="space-y-3">
          <label htmlFor="add-project-base-directory" className="block space-y-1">
            <span className="text-xs font-medium text-foreground">Base directory</span>
            <Input
              id="add-project-base-directory"
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
      </section>

      <section
        className="rounded-2xl border border-border bg-card p-5"
        data-settings-search-target="projects.memory"
      >
        <div className="mb-4">
          <h2 className="text-sm font-medium text-foreground">Project memory</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Persistent context injected into Claude sessions for this project.
          </p>
        </div>

        <div className="space-y-4">
          {selectedProject ? (
            <>
              <div className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                Project memory is injected when a provider session starts. Existing threads may
                continue using older memory until their session is restarted.
              </div>

              <div className="space-y-3 rounded-lg border border-border bg-background p-3">
                <div>
                  <p className="text-sm font-medium text-foreground">Claude sub-agents</p>
                  <p className="text-xs text-muted-foreground">
                    Project-scoped defaults for Claude exploration and verification agents.
                  </p>
                </div>

                <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-card/40 px-3 py-3">
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-foreground">Enable sub-agents</p>
                    <p className="text-xs text-muted-foreground">
                      Allow Claude to spawn helper agents for broad exploration and post-change
                      verification.
                    </p>
                  </div>
                  <Switch
                    checked={selectedProjectClaudeSettings.subagentsEnabled}
                    onCheckedChange={(checked) =>
                      updateSelectedProjectClaudeSettings({
                        subagentsEnabled: checked,
                      })
                    }
                    aria-label="Enable Claude sub-agents"
                  />
                </div>

                <label className="space-y-1">
                  <span className="text-xs font-medium text-foreground">
                    Default sub-agent model
                  </span>
                  <Select
                    value={effectiveClaudeSubagentModel}
                    onValueChange={(value) =>
                      value
                        ? updateSelectedProjectClaudeSettings({
                            subagentModel: value,
                          })
                        : undefined
                    }
                  >
                    <SelectTrigger aria-label="Claude sub-agent model">
                      <SelectValue>{selectedClaudeSubagentModelLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value={CLAUDE_SUBAGENT_MODEL_INHERIT}>
                        Inherit from parent
                      </SelectItem>
                      {claudeSubagentModelOptions
                        .filter((option) => option.slug !== CLAUDE_SUBAGENT_MODEL_INHERIT)
                        .map((option) => (
                          <SelectItem key={option.slug} value={option.slug}>
                            {option.name}
                          </SelectItem>
                        ))}
                    </SelectPopup>
                  </Select>
                </label>

                <p className="text-xs text-muted-foreground">
                  Use <span className="font-mono">inherit</span> to keep sub-agents on the thread
                  model. Any other selection overrides Claude&apos;s{" "}
                  <span className="font-mono">CLAUDE_CODE_SUBAGENT_MODEL</span> for this project.
                </p>

                {(selectedProjectClaudeSettings.subagentsEnabled !==
                  DEFAULT_CLAUDE_PROJECT_SETTINGS.subagentsEnabled ||
                  selectedProjectClaudeSettings.subagentModel !==
                    DEFAULT_CLAUDE_PROJECT_SETTINGS.subagentModel) && (
                  <div className="flex justify-end">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        updateSelectedProjectClaudeSettings({
                          subagentsEnabled: DEFAULT_CLAUDE_PROJECT_SETTINGS.subagentsEnabled,
                          subagentModel: DEFAULT_CLAUDE_PROJECT_SETTINGS.subagentModel,
                        })
                      }
                    >
                      Restore default
                    </Button>
                  </div>
                )}
              </div>

              <div className="space-y-3 rounded-lg border border-border bg-background p-3">
                <div>
                  <p className="text-sm font-medium text-foreground">Add memory</p>
                  <p className="text-xs text-muted-foreground">
                    Save durable feedback, project context, or external references.
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-xs font-medium text-foreground">Type</span>
                    <Select
                      value={memoryDraft.type}
                      onValueChange={(value) => {
                        if (
                          !PROJECT_MEMORY_TYPES.includes(
                            value as (typeof PROJECT_MEMORY_TYPES)[number],
                          )
                        ) {
                          return;
                        }
                        setMemoryDraft((current) => ({
                          ...current,
                          type: value as (typeof PROJECT_MEMORY_TYPES)[number],
                        }));
                        setCreateMemoryError(null);
                      }}
                    >
                      <SelectTrigger aria-label="New project memory type">
                        <SelectValue>{memoryDraft.type}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {PROJECT_MEMORY_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {type}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </label>

                  <label className="space-y-1">
                    <span className="text-xs font-medium text-foreground">Name</span>
                    <Input
                      value={memoryDraft.name}
                      onChange={(event) =>
                        setMemoryDraft((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      onInput={() => setCreateMemoryError(null)}
                      placeholder="Avoid extra comments"
                    />
                  </label>
                </div>

                <label className="space-y-1">
                  <span className="text-xs font-medium text-foreground">Description</span>
                  <Input
                    value={memoryDraft.description}
                    onChange={(event) =>
                      setMemoryDraft((current) => ({
                        ...current,
                        description: event.target.value,
                      }))
                    }
                    onInput={() => setCreateMemoryError(null)}
                    placeholder="Short summary shown in the memory list"
                  />
                </label>

                <label className="space-y-1">
                  <span className="text-xs font-medium text-foreground">Body</span>
                  <Textarea
                    value={memoryDraft.body}
                    onChange={(event) =>
                      setMemoryDraft((current) => ({
                        ...current,
                        body: event.target.value,
                      }))
                    }
                    onInput={() => setCreateMemoryError(null)}
                    className="min-h-28"
                    placeholder="Explain the durable rule or context and why it matters."
                  />
                </label>

                <div className="flex items-center justify-between gap-3">
                  {createMemoryError ? (
                    <p className="text-xs text-destructive">{createMemoryError}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      User and feedback memories stay in user scope. Project and reference memories
                      stay in project scope.
                    </p>
                  )}
                  <Button
                    size="sm"
                    onClick={() => void submitMemoryCreate()}
                    disabled={memoryActionPendingId === "create"}
                  >
                    {memoryActionPendingId === "create" ? "Saving..." : "Save memory"}
                  </Button>
                </div>
              </div>

              <div className="space-y-3">
                {existingMemoryError ? (
                  <p className="text-xs text-destructive">{existingMemoryError}</p>
                ) : null}
                {PROJECT_MEMORY_TYPES.map((type) => {
                  const memories = selectedProjectMemories.filter((memory) => memory.type === type);
                  return (
                    <div key={type} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {type}
                        </h3>
                        <span className="text-xs text-muted-foreground">{memories.length}</span>
                      </div>
                      {memories.length === 0 ? (
                        <p className="rounded-lg border border-dashed border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                          No {type} memories saved.
                        </p>
                      ) : (
                        memories.map((memory) => {
                          const editing = editingMemoryId === memory.id;
                          return (
                            <div
                              key={memory.id}
                              className="rounded-lg border border-border bg-background p-3"
                            >
                              {editing ? (
                                <div className="space-y-3">
                                  <div className="grid gap-3 sm:grid-cols-2">
                                    <label className="space-y-1">
                                      <span className="text-xs font-medium text-foreground">
                                        Type
                                      </span>
                                      <Select
                                        value={editingMemoryDraft.type}
                                        onValueChange={(value) => {
                                          if (
                                            !PROJECT_MEMORY_TYPES.includes(
                                              value as (typeof PROJECT_MEMORY_TYPES)[number],
                                            )
                                          ) {
                                            return;
                                          }
                                          setEditingMemoryDraft((current) => ({
                                            ...current,
                                            type: value as (typeof PROJECT_MEMORY_TYPES)[number],
                                          }));
                                          setExistingMemoryError(null);
                                        }}
                                      >
                                        <SelectTrigger aria-label="Edit project memory type">
                                          <SelectValue>{editingMemoryDraft.type}</SelectValue>
                                        </SelectTrigger>
                                        <SelectPopup>
                                          {PROJECT_MEMORY_TYPES.map((candidate) => (
                                            <SelectItem key={candidate} value={candidate}>
                                              {candidate}
                                            </SelectItem>
                                          ))}
                                        </SelectPopup>
                                      </Select>
                                    </label>
                                    <label className="space-y-1">
                                      <span className="text-xs font-medium text-foreground">
                                        Name
                                      </span>
                                      <Input
                                        value={editingMemoryDraft.name}
                                        onChange={(event) =>
                                          setEditingMemoryDraft((current) => ({
                                            ...current,
                                            name: event.target.value,
                                          }))
                                        }
                                        onInput={() => setExistingMemoryError(null)}
                                      />
                                    </label>
                                  </div>
                                  <label className="space-y-1">
                                    <span className="text-xs font-medium text-foreground">
                                      Description
                                    </span>
                                    <Input
                                      value={editingMemoryDraft.description}
                                      onChange={(event) =>
                                        setEditingMemoryDraft((current) => ({
                                          ...current,
                                          description: event.target.value,
                                        }))
                                      }
                                      onInput={() => setExistingMemoryError(null)}
                                    />
                                  </label>
                                  <label className="space-y-1">
                                    <span className="text-xs font-medium text-foreground">
                                      Body
                                    </span>
                                    <Textarea
                                      value={editingMemoryDraft.body}
                                      onChange={(event) =>
                                        setEditingMemoryDraft((current) => ({
                                          ...current,
                                          body: event.target.value,
                                        }))
                                      }
                                      onInput={() => setExistingMemoryError(null)}
                                      className="min-h-28"
                                    />
                                  </label>
                                  <div className="flex items-center justify-end gap-2">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => {
                                        setEditingMemoryId(null);
                                        setEditingMemoryDraft(EMPTY_MEMORY_DRAFT);
                                        setExistingMemoryError(null);
                                      }}
                                    >
                                      Cancel
                                    </Button>
                                    <Button
                                      size="sm"
                                      onClick={() => void submitMemoryUpdate()}
                                      disabled={memoryActionPendingId === memory.id}
                                    >
                                      {memoryActionPendingId === memory.id
                                        ? "Saving..."
                                        : "Save changes"}
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                <div className="space-y-3">
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="space-y-1">
                                      <p className="text-sm font-medium text-foreground">
                                        {memory.name}
                                      </p>
                                      <p className="text-xs text-muted-foreground">
                                        {memory.description}
                                      </p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <Button
                                        size="xs"
                                        variant="outline"
                                        onClick={() => {
                                          setEditingMemoryId(memory.id);
                                          setEditingMemoryDraft({
                                            type: memory.type,
                                            name: memory.name,
                                            description: memory.description,
                                            body: memory.body,
                                          });
                                          setExistingMemoryError(null);
                                        }}
                                      >
                                        Edit
                                      </Button>
                                      <Button
                                        size="xs"
                                        variant="outline"
                                        onClick={() => void deleteMemory(memory.id, memory.name)}
                                        disabled={memoryActionPendingId === memory.id}
                                      >
                                        {memoryActionPendingId === memory.id
                                          ? "Deleting..."
                                          : "Delete"}
                                      </Button>
                                    </div>
                                  </div>
                                  <pre className="whitespace-pre-wrap rounded-md border border-border/70 bg-card px-3 py-2 text-xs text-foreground">
                                    {memory.body}
                                  </pre>
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <p className="rounded-lg border border-dashed border-border bg-background px-3 py-2 text-xs text-muted-foreground">
              {selectedProjectUnavailable
                ? "The selected project is unavailable. Choose another project to edit memory."
                : "Create a project first to store persistent memory."}
            </p>
          )}
        </div>
      </section>
    </>
  );
}
