import type { ProjectId } from "@t3tools/contracts";

import {
  CLAUDE_SUBAGENT_MODEL_INHERIT,
  DEFAULT_CLAUDE_PROJECT_SETTINGS,
  buildAppSettingsPatch,
} from "../../../appSettings";
import { useSettingsRouteContext } from "../SettingsRouteContext";
import { EMPTY_MEMORY_DRAFT, PROJECT_MEMORY_TYPES } from "../useSettingsRouteState";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Textarea } from "../../ui/textarea";

const ADD_PROJECT_KEYS = ["addProjectBaseDirectory"] as const;

export function ProjectsSettings() {
  const {
    settings,
    defaults,
    updateSettings,
    projects,
    hasProjects,
    selectedProject,
    handleSelectedProjectChange,
    selectedProjectMemories,
    selectedProjectClaudeSettings,
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
                <SelectValue>{selectedProject?.name ?? "Select a project"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
        ) : (
          <p className="rounded-lg border border-dashed border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            Create a project first to configure project-scoped settings.
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

      <section className="rounded-2xl border border-border bg-card p-5">
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
                    value={selectedProjectClaudeSettings.subagentModel}
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
              Create a project first to store persistent memory.
            </p>
          )}
        </div>
      </section>
    </>
  );
}
