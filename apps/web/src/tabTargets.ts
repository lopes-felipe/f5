import { CodeReviewWorkflowId, PlanningWorkflowId, ThreadId } from "@t3tools/contracts";

import {
  resolveSettingsCategoryFromSearch,
  type SettingsCategory,
} from "./components/settings/settingsCategories";

export type TabTargetKey = string;

export type TabTarget =
  | {
      key: TabTargetKey;
      kind: "thread";
      threadId: ThreadId;
    }
  | {
      key: TabTargetKey;
      kind: "settings";
      category: SettingsCategory;
    }
  | {
      key: TabTargetKey;
      kind: "planningWorkflow";
      workflowId: PlanningWorkflowId;
    }
  | {
      key: TabTargetKey;
      kind: "codeReviewWorkflow";
      workflowId: CodeReviewWorkflowId;
    };

export interface TabRouteSnapshot {
  pathname: string;
  routeId: string | null;
  params: Record<string, string | undefined>;
  search: unknown;
}

export function threadTabTargetKey(threadId: ThreadId): TabTargetKey {
  return `thread:${threadId}`;
}

export function settingsTabTargetKey(): TabTargetKey {
  return "settings";
}

export function planningWorkflowTabTargetKey(workflowId: PlanningWorkflowId): TabTargetKey {
  return `planningWorkflow:${workflowId}`;
}

export function codeReviewWorkflowTabTargetKey(workflowId: CodeReviewWorkflowId): TabTargetKey {
  return `codeReviewWorkflow:${workflowId}`;
}

export function parseTabTargetKey(key: TabTargetKey): TabTarget | null {
  if (key === "settings") {
    return {
      key,
      kind: "settings",
      category: "general",
    };
  }

  if (key.startsWith("thread:")) {
    return {
      key,
      kind: "thread",
      threadId: ThreadId.makeUnsafe(key.slice("thread:".length)),
    };
  }

  if (key.startsWith("planningWorkflow:")) {
    return {
      key,
      kind: "planningWorkflow",
      workflowId: PlanningWorkflowId.makeUnsafe(key.slice("planningWorkflow:".length)),
    };
  }

  if (key.startsWith("codeReviewWorkflow:")) {
    return {
      key,
      kind: "codeReviewWorkflow",
      workflowId: CodeReviewWorkflowId.makeUnsafe(key.slice("codeReviewWorkflow:".length)),
    };
  }

  return null;
}

export function resolveTabTargetFromRoute(route: TabRouteSnapshot | null): TabTarget | null {
  if (!route) {
    return null;
  }

  if (route.pathname === "/settings") {
    return {
      key: settingsTabTargetKey(),
      kind: "settings",
      category: resolveSettingsCategoryFromSearch(route.search),
    };
  }

  if (route.pathname.startsWith("/workflow/")) {
    const workflowId = route.params.workflowId;
    if (!workflowId) {
      return null;
    }
    return {
      key: planningWorkflowTabTargetKey(PlanningWorkflowId.makeUnsafe(workflowId)),
      kind: "planningWorkflow",
      workflowId: PlanningWorkflowId.makeUnsafe(workflowId),
    };
  }

  if (route.pathname.startsWith("/code-review/")) {
    const workflowId = route.params.workflowId;
    if (!workflowId) {
      return null;
    }
    return {
      key: codeReviewWorkflowTabTargetKey(CodeReviewWorkflowId.makeUnsafe(workflowId)),
      kind: "codeReviewWorkflow",
      workflowId: CodeReviewWorkflowId.makeUnsafe(workflowId),
    };
  }

  if (route.routeId === "/_chat/$threadId" || route.pathname !== "/") {
    const threadId = route.params.threadId;
    if (!threadId || route.pathname !== `/${threadId}`) {
      return null;
    }
    return {
      key: threadTabTargetKey(ThreadId.makeUnsafe(threadId)),
      kind: "thread",
      threadId: ThreadId.makeUnsafe(threadId),
    };
  }

  return null;
}
