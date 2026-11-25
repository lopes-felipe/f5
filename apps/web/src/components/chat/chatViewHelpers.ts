import {
  codeReviewReviewers,
  findPlanningBranch,
  investigationCrossReviews,
  investigationInvestigators,
  planningBranches,
  planReviewReviewerBranchId,
  requireInvestigator,
} from "@t3tools/shared/workflowParticipants";
import type {
  ProviderDriverKind,
  ProviderKind,
  ThreadId,
  WorkflowModelSlot,
} from "@t3tools/contracts";
import type { deriveActivePlanState } from "../../session-logic";
import {
  type CodeReviewWorkflow,
  type InvestigationWorkflow,
  type PlanningWorkflow,
  type TaskItem as ThreadTaskItem,
} from "../../types";
import { type UnifiedWebSettings } from "../../hooks/useSettings";
import { type FavoritePreset } from "../../favoritePresets";

import { type AppSettings } from "../../appSettings";
import { type TerminalContextDraft } from "../../lib/terminalContext";

export function resolvePlanningWorkflowThreadSlot(
  workflow: PlanningWorkflow,
  threadId: ThreadId,
): WorkflowModelSlot | null {
  if (
    workflow.readerPass?.readerThreadId === threadId ||
    workflow.readerPass?.previousReaderThreadIds?.includes(threadId)
  )
    return workflow.readerSlot ?? null;
  const branches = planningBranches(workflow);
  const author = branches.find((branch) => branch.authorThreadId === threadId);
  if (author) {
    return author.authorSlot;
  }
  if (workflow.merge.threadId === threadId) {
    return workflow.merge.mergeSlot;
  }
  for (const branch of branches) {
    const review = branch.reviews.find((entry) => entry.threadId === threadId);
    if (review) {
      const reviewerId = planReviewReviewerBranchId(workflow, branch.branchId, review);
      return findPlanningBranch(workflow, reviewerId)?.authorSlot ?? null;
    }
  }
  if (workflow.implementation?.threadId === threadId) {
    return workflow.implementation.implementationSlot;
  }
  const codeReview = workflow.implementation?.codeReviews.find(
    (review) => review.threadId === threadId,
  );
  return codeReview?.reviewerSlot ?? null;
}

export function resolveCodeReviewWorkflowThreadSlot(
  workflow: CodeReviewWorkflow,
  threadId: ThreadId,
): WorkflowModelSlot | null {
  const reviewer = codeReviewReviewers(workflow).find(
    (entry) => entry.reviewer.threadId === threadId,
  );
  if (reviewer) {
    return reviewer.reviewer.slot;
  }
  if (workflow.consolidation.threadId === threadId) {
    return workflow.consolidation.slot;
  }
  return null;
}

export function resolveInvestigationWorkflowThreadSlot(
  workflow: InvestigationWorkflow,
  threadId: ThreadId,
): WorkflowModelSlot | null {
  const investigator = investigationInvestigators(workflow).find(
    ({ investigator: entry }) =>
      entry.investigationThreadId === threadId || entry.selfReviewThreadId === threadId,
  );
  if (investigator) {
    return investigator.investigator.slot;
  }
  // A cross-review runs on its reviewer's model.
  const crossReview = investigationCrossReviews(workflow).find(
    (view) => view.threadId === threadId,
  );
  if (crossReview) {
    return requireInvestigator(workflow, crossReview.reviewerId).slot;
  }
  if (workflow.synthesis.threadId === threadId) {
    return workflow.synthesis.slot;
  }
  return null;
}

export const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

export const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

export const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

export function summarizeTaskCounts(tasks: ReadonlyArray<ThreadTaskItem>): string {
  const counts = {
    pending: 0,
    in_progress: 0,
    completed: 0,
  } satisfies Record<ThreadTaskItem["status"], number>;

  for (const task of tasks) {
    counts[task.status] += 1;
  }

  return (
    [
      counts.in_progress > 0 ? `${counts.in_progress} active` : null,
      counts.pending > 0 ? `${counts.pending} pending` : null,
      counts.completed > 0 ? `${counts.completed} done` : null,
    ]
      .filter((entry): entry is string => entry !== null)
      .join(" · ") || "No tasks"
  );
}

export function deriveFallbackTasksFromPlan(
  activePlan: ReturnType<typeof deriveActivePlanState>,
): ThreadTaskItem[] {
  if (!activePlan || activePlan.steps.length === 0) {
    return [];
  }

  return activePlan.steps.map((step, index) => ({
    id: `plan-step:${index}`,
    content: step.step,
    activeForm: step.step,
    status:
      step.status === "completed"
        ? "completed"
        : step.status === "inProgress"
          ? "in_progress"
          : "pending",
  }));
}

const DIALOG_POPUP_SELECTOR = '[data-slot="dialog-popup"]';
const DIALOG_PORTALED_POPUP_SELECTOR = [
  '[data-slot="combobox-positioner"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="menu-positioner"]',
  '[data-slot="menu-popup"]',
  '[data-slot="popover-positioner"]',
  '[data-slot="popover-popup"]',
  '[data-slot="select-positioner"]',
  '[data-slot="select-popup"]',
].join(",");

export function isEventInDialogKeybindingContext(event: globalThis.KeyboardEvent): boolean {
  const eventTarget = event.target instanceof Node ? event.target : null;
  const eventTargetElement =
    event.target instanceof Element ? event.target : eventTarget?.parentElement;
  if (eventTargetElement?.closest(DIALOG_POPUP_SELECTOR)) {
    return true;
  }

  if (!document.querySelector(DIALOG_POPUP_SELECTOR)) {
    return false;
  }

  return Boolean(eventTargetElement?.closest(DIALOG_PORTALED_POPUP_SELECTOR));
}

export function providerKindForDriver(driver: ProviderDriverKind): ProviderKind | null {
  return driver === "codex" ||
    driver === "claudeAgent" ||
    driver === "cursor" ||
    driver === "opencode" ||
    driver === "grok" ||
    driver === "antigravity"
    ? (driver as ProviderKind)
    : null;
}

// ChatView reads settings through these selectors, so a write to any other setting keeps
// the selection's identity and does not re-render the conversation.
export function selectChatViewSettings(settings: AppSettings) {
  return {
    alwaysExpandAgentCommandTranscripts: settings.alwaysExpandAgentCommandTranscripts,
    claudeBinaryPath: settings.claudeBinaryPath,
    claudeLaunchArgs: settings.claudeLaunchArgs,
    claudeProjectSettings: settings.claudeProjectSettings,
    claudeSubagentDefaults: settings.claudeSubagentDefaults,
    codexBinaryPath: settings.codexBinaryPath,
    codexHomePath: settings.codexHomePath,
    compactChatLayout: settings.compactChatLayout,
    codexThreadTitleModel: settings.codexThreadTitleModel,
    customClaudeModels: settings.customClaudeModels,
    customCodexModels: settings.customCodexModels,
    customGrokModels: settings.customGrokModels,
    followUpBehavior: settings.followUpBehavior,
    gitStatusAutoRefreshIntervalSeconds: settings.gitStatusAutoRefreshIntervalSeconds,
    openFileLinksInPanel: settings.openFileLinksInPanel,
    proactivePanelsEnabled: settings.proactivePanelsEnabled,
    providerModelPreferences: settings.providerModelPreferences,
    runtimeWarningVisibility: settings.runtimeWarningVisibility,
    screenReaderAnnouncements: settings.screenReaderAnnouncements,
    sendShortcut: settings.sendShortcut,
    showAgentCommandTranscripts: settings.showAgentCommandTranscripts,
    showFileChangeDiffsInline: settings.showFileChangeDiffsInline,
    showPromptCacheIndicator: settings.showPromptCacheIndicator,
    showProviderRuntimeMetadata: settings.showProviderRuntimeMetadata,
    tasksPanelAutoOpen: settings.tasksPanelAutoOpen,
    timestampFormat: settings.timestampFormat,
    workLogFilter: settings.workLogFilter,
    workLogMode: settings.workLogMode,
  };
}

export function selectFavoritePresets(settings: UnifiedWebSettings): ReadonlyArray<FavoritePreset> {
  return settings.favorites;
}
