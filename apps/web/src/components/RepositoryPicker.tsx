import type { ProjectId, ProjectRepository, ThreadId } from "@t3tools/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon, FolderGit2Icon, FolderIcon, GitForkIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { cn } from "../lib/utils";
import { ensureNativeApi } from "../nativeApi";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";

export function useWorktreeRepositoryChoices(projectId: ProjectId | null) {
  const key = projectId === null ? null : "f5:worktree-repositories:" + projectId;
  const [choices, setChoices] = useState<Readonly<Record<string, ReadonlyArray<string>>>>({});
  const persisted = useMemo(() => {
    if (key === null) return undefined;
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
      return Array.isArray(value) &&
        value.length <= 128 &&
        value.every((entry): entry is string => typeof entry === "string")
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  }, [key]);
  return {
    selection: key === null ? undefined : (choices[key] ?? persisted),
    select: (paths: ReadonlyArray<string>) => {
      if (key === null) return;
      setChoices((current) => ({ ...current, [key]: paths }));
      try {
        localStorage.setItem(key, JSON.stringify(paths));
      } catch {
        // The in-memory selection still applies if local storage is unavailable.
      }
    },
  };
}

export function projectRepositoriesQueryOptions(
  projectId: ProjectId | null,
  threadId: ThreadId | null = null,
  workspaceRoot?: string | null,
) {
  return queryOptions({
    queryKey: ["projects", projectId, "repositories", threadId, workspaceRoot] as const,
    enabled: projectId !== null,
    queryFn: async () => {
      if (!projectId) return [];
      const repositories = await ensureNativeApi().projects.listRepositories({
        projectId,
        ...(threadId ? { threadId } : {}),
      });
      return Array.isArray(repositories) ? repositories : [];
    },
    staleTime: 5_000,
  });
}

export function useRepositoryPicker(
  projectId: ProjectId | null,
  threadId: ThreadId | null,
  workspaceRoot: string | null,
) {
  const { data: repositories = [] } = useQuery(
    projectRepositoriesQueryOptions(projectId, threadId, workspaceRoot),
  );
  const [selection, setSelection] = useState<{ threadId: ThreadId | null; path: string }>();
  const repository =
    repositories.find(
      (entry) => selection?.threadId === threadId && entry.path === selection.path,
    ) ?? repositories[0];
  return {
    repositories,
    repository,
    select: (path: string) => setSelection({ threadId, path }),
  };
}

export function RepositoryPicker(props: {
  repositories: ReadonlyArray<ProjectRepository>;
  repository: ProjectRepository | undefined;
  select: (path: string) => void;
}) {
  if (props.repositories.length < 2) return null;
  return (
    <Select
      value={props.repository?.path ?? null}
      onValueChange={(value) => {
        if (value !== null) props.select(value);
      }}
    >
      <SelectTrigger aria-label="Repository" className="max-w-40">
        <SelectValue>
          {props.repository?.externalSource ??
            (props.repository?.relativePath === "."
              ? "Project root"
              : props.repository?.relativePath)}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {props.repositories.map((repository) => (
          <SelectItem key={repository.path} value={repository.path}>
            {repository.externalSource ??
              (repository.relativePath === "." ? "Project root" : repository.relativePath)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * The repositories a new worktree includes. Without a saved choice, small
 * projects include every repository; larger ones include none until picked.
 * Mirrors the server's `selectNestedWorktreeRepositories` default.
 */
export function resolveWorktreeRepositorySelection(
  repositories: ReadonlyArray<ProjectRepository>,
  selected: ReadonlyArray<string> | undefined,
  plain: boolean,
): ReadonlyArray<string> {
  return (
    selected ??
    (repositories.length <= (plain ? 8 : 7)
      ? repositories.map((repository) => repository.relativePath)
      : [])
  );
}

function repositoryLabel(repository: ProjectRepository) {
  return repository.externalSource ?? repository.relativePath;
}

/** Search only pays off once the list no longer fits at a glance. */
const REPOSITORY_SEARCH_THRESHOLD = 8;

function RepositoryChecklist(props: {
  repositories: ReadonlyArray<ProjectRepository>;
  selected: ReadonlyArray<string>;
  onChange: (paths: ReadonlyArray<string>) => void;
}) {
  const { repositories } = props;
  const [query, setQuery] = useState("");
  const selected = new Set(props.selected);
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? repositories.filter((repository) =>
        repositoryLabel(repository).toLowerCase().includes(needle),
      )
    : repositories;
  const commit = (next: ReadonlySet<string>) =>
    props.onChange(
      repositories.flatMap((row) => (next.has(row.relativePath) ? [row.relativePath] : [])),
    );
  const setVisible = (checked: boolean) => {
    const next = new Set(selected);
    for (const repository of visible) {
      if (checked) next.add(repository.relativePath);
      else next.delete(repository.relativePath);
    }
    commit(next);
  };
  return (
    <div className="flex min-h-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 px-1 text-2xs text-muted-foreground">
        <span>
          Repositories · {selected.size} of {repositories.length}
        </span>
        <span className="flex items-center gap-1">
          <Button size="xs" variant="ghost" className="h-5 px-1.5" onClick={() => setVisible(true)}>
            {needle ? "Select matches" : "Select all"}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            className="h-5 px-1.5"
            disabled={selected.size === 0}
            onClick={() => setVisible(false)}
          >
            Clear
          </Button>
        </span>
      </div>
      {repositories.length > REPOSITORY_SEARCH_THRESHOLD && (
        <Input
          size="sm"
          type="search"
          aria-label="Search repositories"
          placeholder="Search repositories…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      <div
        role="group"
        aria-label="Repositories"
        className="max-h-60 min-h-0 overflow-y-auto rounded-md border"
      >
        {visible.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
            No repositories match.
          </p>
        ) : (
          visible.map((repository) => (
            <label
              key={repository.relativePath}
              className="flex cursor-pointer items-center gap-2 px-2 py-1 text-xs hover:bg-accent"
            >
              <Checkbox
                checked={selected.has(repository.relativePath)}
                onCheckedChange={(checked) => {
                  const next = new Set(selected);
                  if (checked) next.add(repository.relativePath);
                  else next.delete(repository.relativePath);
                  commit(next);
                }}
              />
              <span className="min-w-0 flex-1 truncate font-mono">
                {repositoryLabel(repository)}
              </span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}

const toolbarTriggerClassName =
  "h-6 min-w-0 text-2xs font-normal text-muted-foreground hover:text-foreground sm:h-6";

function pluralRepos(count: number) {
  return `${count} ${count === 1 ? "repo" : "repos"}`;
}

/** Nested repositories a git project's new worktree also checks out. */
export function WorktreeRepositoryPicker(props: {
  repositories: ReadonlyArray<ProjectRepository>;
  selected: ReadonlyArray<string> | undefined;
  onChange: (paths: ReadonlyArray<string>) => void;
  disabled?: boolean;
}) {
  const { repositories } = props;
  if (repositories.length === 0) return null;
  const selection = resolveWorktreeRepositorySelection(repositories, props.selected, false);
  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="ghost" size="xs" />}
        className={toolbarTriggerClassName}
        disabled={props.disabled === true}
        aria-label={`Nested repositories: ${selection.length} selected`}
      >
        <FolderGit2Icon className="size-3 shrink-0" />
        Repositories · {selection.length}
        <ChevronDownIcon />
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" className="w-96 max-w-[calc(100vw-2rem)]">
        <div className="flex flex-col gap-2">
          <p className="px-1 text-xs text-muted-foreground">
            Nested repositories to check out in the new worktree alongside the project.
          </p>
          <RepositoryChecklist
            repositories={repositories}
            selected={selection}
            onChange={props.onChange}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function ModeRow(props: {
  icon: ReactNode;
  title: string;
  description: string;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={props.selected}
      className={cn(
        "flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none hover:bg-accent focus-visible:bg-accent",
        props.selected && "bg-accent text-foreground",
      )}
      onClick={props.onPick}
    >
      <span className="mt-0.5">{props.icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{props.title}</span>
        <span className="text-2xs text-muted-foreground">{props.description}</span>
      </span>
      {props.selected && <CheckIcon className="mt-0.5 size-3 shrink-0" />}
    </button>
  );
}

/**
 * Where a thread works when the project folder is not a git repository but
 * holds repositories: the folder itself, or a new worktree group of the
 * selected repositories with the rest of the folder linked in.
 */
export function PlainGroupWorkspacePicker(props: {
  projectCwd: string;
  worktree: boolean;
  onWorktreeChange: (worktree: boolean) => void;
  repositories: ReadonlyArray<ProjectRepository>;
  selected: ReadonlyArray<string> | undefined;
  onSelectedChange: (paths: ReadonlyArray<string>) => void;
  baseBranch: string;
  onBaseBranchChange: (branch: string) => void;
  disabled?: boolean;
}) {
  const { repositories, worktree } = props;
  const selection = resolveWorktreeRepositorySelection(repositories, props.selected, true);
  const label = worktree
    ? selection.length === 0
      ? "New worktree · pick repositories"
      : `New worktree · ${pluralRepos(selection.length)}`
    : "Local";
  const TriggerIcon = worktree ? GitForkIcon : FolderIcon;
  return (
    <Popover>
      <PopoverTrigger
        render={<Button data-composer-control="branch" variant="ghost" size="xs" />}
        className={cn(
          toolbarTriggerClassName,
          worktree && selection.length === 0 && "text-warning-foreground",
        )}
        title={props.projectCwd}
        aria-label={`Workspace: ${label}`}
        disabled={props.disabled === true}
      >
        <TriggerIcon className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
        <ChevronDownIcon />
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" className="w-96 max-w-[calc(100vw-2rem)]">
        <div className="flex flex-col gap-2">
          <div role="menu" aria-label="Workspace" className="flex flex-col gap-0.5">
            <ModeRow
              icon={<FolderIcon className="size-3" />}
              title="Project folder"
              description="Work directly in this folder."
              selected={!worktree}
              onPick={() => props.onWorktreeChange(false)}
            />
            <ModeRow
              icon={<GitForkIcon className="size-3" />}
              title="New worktree"
              description="Check out the selected repositories on a new branch when you send."
              selected={worktree}
              onPick={() => props.onWorktreeChange(true)}
            />
          </div>
          {worktree && (
            <>
              <RepositoryChecklist
                repositories={repositories}
                selected={selection}
                onChange={props.onSelectedChange}
              />
              <Input
                size="sm"
                aria-label="Base branch"
                placeholder="Base branch: each repo's current branch"
                value={props.baseBranch}
                onChange={(event) => props.onBaseBranchChange(event.target.value)}
              />
              <p className="px-1 text-2xs text-muted-foreground">
                Files outside the selected repositories link to the original project folder.
              </p>
            </>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
