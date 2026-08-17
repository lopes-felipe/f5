import type { ReactNode } from "react";

import { parseGlobalSearchQuery } from "../lib/globalSearchQuery";
import type { Project, Thread } from "../types";
import {
  buildThreadActionItems,
  filterCommandPaletteGroups,
  type CommandPaletteActionItem,
} from "./CommandPalette.logic";

export function buildSidebarThreadSearchItems(input: {
  query: string;
  projects: ReadonlyArray<Project>;
  threads: ReadonlyArray<Thread>;
  activeThreadId?: Thread["id"];
  icon: ReactNode;
  runThread: (thread: Thread) => Promise<void>;
  limit?: number;
}): CommandPaletteActionItem[] {
  const parsed = parseGlobalSearchQuery(input.query);
  const normalizedProjectFilter = parsed.project?.toLowerCase() ?? null;
  const project = normalizedProjectFilter
    ? input.projects.find(
        (candidate) =>
          candidate.id.toLowerCase() === normalizedProjectFilter ||
          candidate.name.toLowerCase() === normalizedProjectFilter,
      )
    : null;
  if (normalizedProjectFilter && !project) {
    return [];
  }

  const projectTitleById = new Map(input.projects.map(({ id, name }) => [id, name] as const));
  const items = buildThreadActionItems({
    threads: project
      ? input.threads.filter((thread) => thread.projectId === project.id)
      : input.threads,
    ...(input.activeThreadId ? { activeThreadId: input.activeThreadId } : {}),
    projectTitleById,
    icon: input.icon,
    runThread: input.runThread,
  });
  const filteredItems =
    parsed.text.length === 0
      ? items
      : (filterCommandPaletteGroups({
          activeGroups: [],
          query: parsed.text,
          isInSubmenu: false,
          projectSearchItems: [],
          threadSearchItems: items,
        }).find((group) => group.value === "threads-search")?.items ?? []);

  return (input.limit === undefined ? filteredItems : filteredItems.slice(0, input.limit)).filter(
    (item): item is CommandPaletteActionItem => item.kind === "action",
  );
}
