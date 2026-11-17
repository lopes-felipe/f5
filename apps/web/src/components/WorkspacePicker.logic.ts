import type { GitBranch, WorktreeListEntry } from "@t3tools/contracts";

import { deriveLocalBranchNameFromRemoteRef, sanitizeNewRefName } from "./BranchToolbar.logic";

/**
 * Where the thread works, as the picker shows it. A draft "new worktree" has
 * no path yet: the worktree is created from `base` when the first message is
 * sent.
 */
export type WorkspaceState =
  | { readonly kind: "local" }
  | { readonly kind: "newWorktree"; readonly base: string | null }
  | { readonly kind: "worktree"; readonly path: string; readonly branch: string | null };

export type WorkspaceAction =
  | "switchBranch"
  | "moveToWorktree"
  | "manageWorktrees"
  | "discardMove"
  | "removeWorktree";

export type WorkspaceRow =
  | { readonly kind: "header"; readonly key: string; readonly label: string }
  | {
      readonly kind: "notice";
      readonly key: string;
      readonly text: string;
      readonly tone: "muted" | "warning";
    }
  | {
      readonly kind: "local";
      readonly key: string;
      readonly branch: string | null;
      readonly threadCount: number;
      readonly selected: boolean;
    }
  | {
      readonly kind: "newWorktree";
      readonly key: string;
      readonly branch: string;
      readonly isDefault: boolean;
      readonly isRemote: boolean;
      readonly selected: boolean;
    }
  | {
      readonly kind: "openWorktree";
      readonly key: string;
      readonly branch: string;
      readonly path: string;
      readonly threadCount: number;
      readonly selected: boolean;
    }
  | {
      readonly kind: "newBranchWorktree";
      readonly key: string;
      readonly name: string;
      readonly base: string;
    }
  | { readonly kind: "pullRequest"; readonly key: string; readonly reference: string }
  | {
      readonly kind: "action";
      readonly key: string;
      readonly action: WorkspaceAction;
      readonly label: string;
      readonly disabled: boolean;
      readonly destructive: boolean;
    }
  | { readonly kind: "back"; readonly key: string; readonly label: string }
  | {
      readonly kind: "switchTarget";
      readonly key: string;
      readonly branch: string;
      readonly current: boolean;
      readonly isRemote: boolean;
      readonly disabled: boolean;
    }
  | {
      readonly kind: "createBranchHere";
      readonly key: string;
      readonly name: string;
      readonly disabled: boolean;
    };

export type SelectableWorkspaceRow = Exclude<WorkspaceRow, { kind: "header" | "notice" }>;

export const isSelectableRow = (row: WorkspaceRow): row is SelectableWorkspaceRow =>
  row.kind !== "header" && row.kind !== "notice";

export interface WorkspaceRowsInput {
  readonly mode: "pick" | "switch";
  readonly query: string;
  /** No server thread yet: picks change the draft, and worktrees are created on send. */
  readonly isDraft: boolean;
  readonly threadId: string;
  readonly state: WorkspaceState;
  /** The server is still creating this thread's worktree. */
  readonly creatingWorktree: boolean;
  readonly projectCwd: string;
  /** Branch checked out in the project folder, when known. */
  readonly projectBranch: string | null;
  /** Branches deduplicated against their remotes. */
  readonly branches: ReadonlyArray<GitBranch>;
  /** Linked conversations per checkout path, from the worktree inventory. */
  readonly linkedThreads: ReadonlyMap<string, ReadonlyArray<{ readonly threadId: string }>>;
  readonly checkoutMissing: boolean;
  readonly prReference: string | null;
  readonly canCheckoutPullRequest: boolean;
  /** Several models are selected: each gets an independently named worktree. */
  readonly multiModel: boolean;
  readonly canMove: boolean;
  readonly moveDisabled: boolean;
  readonly hasCompletedMove: boolean;
  /** Why an in-place switch is refused right now; null while unknown or allowed. */
  readonly switchBlockedReason: string | null;
  /** The switch availability check has not answered yet. */
  readonly switchChecking?: boolean;
}

const matches = (normalizedQuery: string, ...values: ReadonlyArray<string | null>) =>
  normalizedQuery.length === 0 ||
  values.some((value) => {
    if (!value) return false;
    const lower = value.toLowerCase();
    return lower.includes(normalizedQuery) || lower.includes(sanitizeNewRefName(normalizedQuery));
  });

/** Other conversations linked to `path`; the asking thread never counts. */
export function linkedThreadCount(
  linkedThreads: WorkspaceRowsInput["linkedThreads"],
  path: string,
  threadId: string,
): number {
  return (linkedThreads.get(path) ?? []).filter((thread) => thread.threadId !== threadId).length;
}

export function linkedThreadsByPath(
  entries: ReadonlyArray<WorktreeListEntry> | undefined,
): ReadonlyMap<string, ReadonlyArray<{ readonly threadId: string }>> {
  const map = new Map<string, ReadonlyArray<{ readonly threadId: string }>>();
  for (const entry of entries ?? []) {
    map.set(entry.path, entry.linkedThreads);
    if (entry.canonicalPath !== entry.path) map.set(entry.canonicalPath, entry.linkedThreads);
  }
  return map;
}

/** The checkout an in-place switch would change, or null when there is none. */
export function switchCheckoutPath(state: WorkspaceState, projectCwd: string): string | null {
  if (state.kind === "local") return projectCwd;
  if (state.kind === "worktree") return state.path;
  return null;
}

const hasSecondaryWorktree = (branch: GitBranch, projectCwd: string) =>
  branch.worktreePath !== null && branch.worktreePath !== projectCwd;

/**
 * Every row of the workspace picker, in display order, with header and notice
 * rows interleaved. Each row states what picking it does, so no pick needs a
 * dialog.
 */
export function buildWorkspaceRows(input: WorkspaceRowsInput): ReadonlyArray<WorkspaceRow> {
  return input.mode === "switch" ? buildSwitchRows(input) : buildPickRows(input);
}

function buildPickRows(input: WorkspaceRowsInput): ReadonlyArray<WorkspaceRow> {
  const query = input.query.trim();
  const normalized = query.toLowerCase();
  const rows: WorkspaceRow[] = [];
  const section = (key: string, label: string, entries: ReadonlyArray<WorkspaceRow>) => {
    if (entries.length === 0) return;
    rows.push({ kind: "header", key: `header:${key}`, label }, ...entries);
  };

  if (input.prReference && input.canCheckoutPullRequest && !input.checkoutMissing)
    rows.push({ kind: "pullRequest", key: "pull-request", reference: input.prReference });

  if (input.creatingWorktree) {
    rows.push({
      kind: "notice",
      key: "notice:creating",
      text: "The worktree is being created. Manage it once setup finishes.",
      tone: "muted",
    });
  } else {
    const local: WorkspaceRow[] = matches(normalized, "local", input.projectBranch)
      ? [
          {
            kind: "local",
            key: "local",
            branch: input.projectBranch,
            threadCount: linkedThreadCount(input.linkedThreads, input.projectCwd, input.threadId),
            selected: input.state.kind === "local",
          },
        ]
      : [];
    section("local", "Project folder", local);

    if (input.isDraft) {
      const selectedBase = input.state.kind === "newWorktree" ? input.state.base : null;
      const candidates = input.branches
        .filter((branch) => branch.isDefault || !hasSecondaryWorktree(branch, input.projectCwd))
        .filter((branch) => matches(normalized, branch.name));
      const ordered = [
        ...candidates.filter((branch) => branch.isDefault),
        ...candidates.filter((branch) => !branch.isDefault),
      ];
      section(
        "new",
        "New worktree from",
        ordered.map((branch) => ({
          kind: "newWorktree" as const,
          key: `new:${branch.name}`,
          branch: branch.name,
          isDefault: branch.isDefault,
          isRemote: branch.isRemote === true,
          selected: branch.name === selectedBase,
        })),
      );
    }

    const open = input.branches
      .filter((branch) => hasSecondaryWorktree(branch, input.projectCwd))
      .filter((branch) => matches(normalized, branch.name, branch.worktreePath))
      .map((branch) => ({
        kind: "openWorktree" as const,
        key: `open:${branch.worktreePath}`,
        branch: branch.name,
        path: branch.worktreePath!,
        threadCount: linkedThreadCount(input.linkedThreads, branch.worktreePath!, input.threadId),
        selected: input.state.kind === "worktree" && input.state.path === branch.worktreePath,
      }));
    section("open", "Open worktrees", open);

    const name = sanitizeNewRefName(query);
    if (
      input.isDraft &&
      !input.multiModel &&
      name.length > 0 &&
      !input.prReference &&
      !input.branches.some((branch) => branch.name === name)
    ) {
      const base =
        (input.state.kind === "newWorktree" ? input.state.base : null) ??
        input.branches.find((branch) => branch.isDefault)?.name ??
        input.projectBranch;
      if (base) rows.push({ kind: "newBranchWorktree", key: `new-branch:${name}`, name, base });
    }
  }

  if (normalized.length === 0) {
    const actions: WorkspaceRow[] = [];
    const action = (
      key: WorkspaceAction,
      label: string,
      options: { disabled?: boolean; destructive?: boolean } = {},
    ) =>
      actions.push({
        kind: "action",
        key: `action:${key}`,
        action: key,
        label,
        disabled: options.disabled ?? false,
        destructive: options.destructive ?? false,
      });
    if (
      !input.creatingWorktree &&
      !input.checkoutMissing &&
      switchCheckoutPath(input.state, input.projectCwd) !== null
    )
      action("switchBranch", "Switch branch here…");
    if (input.canMove)
      action("moveToWorktree", "Move to a new worktree…", { disabled: input.moveDisabled });
    action("manageWorktrees", "Manage worktrees…");
    if (input.hasCompletedMove) action("discardMove", "Discard originals from move…");
    if (input.state.kind === "worktree")
      action("removeWorktree", "Remove worktree…", { destructive: true });
    section("manage", "Manage", actions);
  }
  return rows;
}

function buildSwitchRows(input: WorkspaceRowsInput): ReadonlyArray<WorkspaceRow> {
  const query = input.query.trim();
  const normalized = query.toLowerCase();
  const checkout = switchCheckoutPath(input.state, input.projectCwd);
  const blocked = input.switchBlockedReason !== null;
  // Until availability is known, nothing can be switched to.
  const disabled = blocked || input.switchChecking === true;
  // Back stays out of the way of Enter while a query names a target.
  const rows: WorkspaceRow[] =
    query.length === 0 ? [{ kind: "back", key: "back", label: "Back" }] : [];
  if (blocked)
    rows.push({
      kind: "notice",
      key: "notice:blocked",
      text: input.switchBlockedReason!,
      tone: "warning",
    });
  else if (input.switchChecking === true)
    rows.push({
      kind: "notice",
      key: "notice:checking",
      text: "Checking who uses this checkout…",
      tone: "muted",
    });
  // Live Git state names the checked-out branch; the recorded branch is only a
  // fallback, so an outside checkout change cannot leave two branches "current".
  const liveBranch = input.branches.find((branch) => branch.worktreePath === checkout)?.name;
  const currentBranch =
    liveBranch ??
    (input.state.kind === "local"
      ? input.projectBranch
      : input.state.kind === "worktree"
        ? input.state.branch
        : null);
  // A branch checked out in another checkout cannot be checked out here too.
  const targets = input.branches
    .filter((branch) => branch.worktreePath === null || branch.worktreePath === checkout)
    .filter((branch) => matches(normalized, branch.name))
    .map((branch) => {
      const current = branch.name === currentBranch;
      return {
        kind: "switchTarget" as const,
        key: `switch:${branch.name}`,
        branch: branch.name,
        current,
        isRemote: branch.isRemote === true,
        disabled: disabled || current,
      };
    });
  rows.push({
    kind: "header",
    key: "header:switch",
    label: input.state.kind === "local" ? "Switch Local to" : "Switch this worktree to",
  });
  rows.push(...targets);
  const name = sanitizeNewRefName(query);
  if (
    name.length > 0 &&
    !input.branches.some(
      (branch) =>
        branch.name === name ||
        (branch.isRemote === true && deriveLocalBranchNameFromRemoteRef(branch.name) === name),
    )
  )
    rows.push({ kind: "createBranchHere", key: `create:${name}`, name, disabled });
  return rows;
}

export function workspaceTriggerLabel(input: {
  readonly state: WorkspaceState;
  readonly creatingWorktree: boolean;
  readonly activeThreadBranch: string | null;
  readonly projectBranch: string | null;
  readonly checkoutMissing: boolean;
}): string {
  if (input.creatingWorktree)
    return input.activeThreadBranch
      ? `New worktree · from ${input.activeThreadBranch}`
      : "New worktree";
  switch (input.state.kind) {
    case "local":
      return input.projectBranch ? `Local · ${input.projectBranch}` : "Local";
    case "newWorktree":
      return input.state.base ? `New worktree · from ${input.state.base}` : "New worktree";
    case "worktree": {
      const name = input.state.branch ?? input.state.path.split(/[\\/]/).filter(Boolean).at(-1);
      return input.checkoutMissing ? `${name} · missing` : (name ?? "Worktree");
    }
  }
}
