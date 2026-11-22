import type { ProjectId, ProjectRepository, ThreadId } from "@t3tools/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { ensureNativeApi } from "../nativeApi";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Button } from "./ui/button";

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
    queryFn: () =>
      projectId
        ? ensureNativeApi().projects.listRepositories({
            projectId,
            ...(threadId ? { threadId } : {}),
          })
        : Promise.resolve([]),
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

export function WorktreeRepositoryPicker(props: {
  repositories: ReadonlyArray<ProjectRepository>;
  plain?: boolean;
  selected: ReadonlyArray<string> | undefined;
  onChange: (paths: ReadonlyArray<string>) => void;
}) {
  const { repositories } = props;
  if (repositories.length === 0) return null;
  const selection =
    props.selected ??
    (repositories.length <= (props.plain ? 8 : 7)
      ? repositories.map((repository) => repository.relativePath)
      : []);
  const selected = new Set(selection);
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="outline" />}>
        Repositories ({selected.size})
      </MenuTrigger>
      <MenuPopup>
        {repositories.map(({ relativePath, externalSource }) => (
          <MenuCheckboxItem
            key={relativePath}
            checked={selected.has(relativePath)}
            onCheckedChange={(checked) => {
              if (checked) selected.add(relativePath);
              else selected.delete(relativePath);
              props.onChange(
                repositories.flatMap((row) =>
                  selected.has(row.relativePath) ? [row.relativePath] : [],
                ),
              );
            }}
          >
            {externalSource ?? relativePath}
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
