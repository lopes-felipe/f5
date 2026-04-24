import {
  DEFAULT_NEW_THREAD_TITLE,
  ThreadId,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { resolveShortcutBinding, type ShortcutEventLike } from "../keybindings";
import { isDraftThreadId } from "../lib/draftThreads";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isArchivedThread } from "../lib/threadOrdering";
import { useStore } from "../store";
import {
  codeReviewWorkflowTabTargetKey,
  parseTabTargetKey,
  planningWorkflowTabTargetKey,
  resolveTabTargetFromRoute,
  settingsTabTargetKey,
  threadTabTargetKey,
  type TabRouteSnapshot,
  type TabTarget,
  type TabTargetKey,
} from "../tabTargets";
import {
  advanceCycle,
  beginCycle,
  EMPTY_THREAD_RECENCY_STATE,
  endCycle,
  getCycleTargetKey,
  pruneRecentTabTargets,
  recordTabTargetVisit,
  type ThreadRecencyHeldModifiers,
  type ThreadRecencyState,
} from "../threadRecency";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { isWsInteractionBlocked, useWsConnectionState } from "../wsConnectionState";
import { SETTINGS_CATEGORY_LABELS, type SettingsCategory } from "./settings/settingsCategories";
import { resolveThreadStatusPillForThread } from "../threadStatus";
import ThreadCyclePicker from "./ThreadCyclePicker";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

function areRequiredHeldModifiersPressed(
  heldModifiers: ThreadRecencyHeldModifiers,
  event: Pick<ShortcutEventLike, "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
): boolean {
  return (
    (!heldModifiers.ctrlKey || event.ctrlKey) &&
    (!heldModifiers.metaKey || event.metaKey) &&
    (!heldModifiers.altKey || event.altKey) &&
    (!heldModifiers.shiftKey || event.shiftKey)
  );
}

function currentTerminalOpen(threadId: ThreadId | null): boolean {
  if (!threadId) return false;
  return selectThreadTerminalState(
    useTerminalStateStore.getState().terminalStateByThreadId,
    threadId,
  ).terminalOpen;
}

function resolveCycleDirection(binding: ResolvedKeybindingRule | null): "next" | "previous" | null {
  if (binding?.command === "thread.switchRecentNext") {
    return "next";
  }
  if (binding?.command === "thread.switchRecentPrevious") {
    return "previous";
  }
  return null;
}

function fallbackTitleForTarget(target: TabTarget | null): string {
  if (!target) {
    return "Unknown tab";
  }

  switch (target.kind) {
    case "thread":
      return target.threadId;
    case "settings":
      return "Settings";
    case "planningWorkflow":
      return "Feature workflow";
    case "codeReviewWorkflow":
      return "Code review workflow";
  }
}

export default function ThreadRecencyController() {
  const navigate = useNavigate();
  const routeSnapshot = useRouterState({
    select: (state) => {
      const lastMatch = state.matches.at(-1);
      return {
        pathname: state.location.pathname,
        routeId: lastMatch?.routeId ?? null,
        params: lastMatch ? { ...lastMatch.params } : {},
        search: state.location.search,
      } satisfies TabRouteSnapshot;
    },
  });
  const currentRouteTarget = useMemo(
    () => resolveTabTargetFromRoute(routeSnapshot),
    [routeSnapshot],
  );
  const currentRouteTargetKind = currentRouteTarget?.kind ?? null;
  const currentRouteSettingsCategory =
    currentRouteTarget?.kind === "settings" ? currentRouteTarget.category : null;
  const currentTargetKey = currentRouteTarget?.key ?? null;
  const currentRouteThreadId =
    currentRouteTarget?.kind === "thread" ? currentRouteTarget.threadId : null;
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const planningWorkflows = useStore((store) => store.planningWorkflows);
  const codeReviewWorkflows = useStore((store) => store.codeReviewWorkflows);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const { data: keybindings = EMPTY_KEYBINDINGS } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });
  const [recencyState, setRecencyState] = useState<ThreadRecencyState>(EMPTY_THREAD_RECENCY_STATE);
  const [lastVisitedSettingsCategory, setLastVisitedSettingsCategory] =
    useState<SettingsCategory>("general");
  const wsConnectionState = useWsConnectionState();
  const wsInteractionBlocked = isWsInteractionBlocked(wsConnectionState.phase);

  const eligibleTargetKeys = useMemo(() => {
    const threadTargetKeys = threads
      .filter((thread) => !isArchivedThread(thread))
      .map((thread) => threadTabTargetKey(thread.id));
    const draftTargetKeys = Object.keys(draftThreadsByThreadId).map((threadId) =>
      threadTabTargetKey(ThreadId.makeUnsafe(threadId)),
    );
    const workflowTargetKeys = planningWorkflows.map((workflow) =>
      planningWorkflowTabTargetKey(workflow.id),
    );
    const codeReviewTargetKeys = codeReviewWorkflows.map((workflow) =>
      codeReviewWorkflowTabTargetKey(workflow.id),
    );

    return [
      ...threadTargetKeys,
      ...draftTargetKeys,
      settingsTabTargetKey(),
      ...workflowTargetKeys,
      ...codeReviewTargetKeys,
    ];
  }, [codeReviewWorkflows, draftThreadsByThreadId, planningWorkflows, threads]);

  const eligibleTargetKeySet = useMemo(() => new Set(eligibleTargetKeys), [eligibleTargetKeys]);
  const recencyStateRef = useRef(recencyState);
  const keybindingsRef = useRef(keybindings);
  const eligibleTargetKeysRef = useRef(eligibleTargetKeys);
  const eligibleTargetKeySetRef = useRef(eligibleTargetKeySet);
  const currentTargetKeyRef = useRef<TabTargetKey | null>(currentTargetKey);
  const currentRouteThreadIdRef = useRef<ThreadId | null>(currentRouteThreadId);
  const previousTargetKeyRef = useRef<TabTargetKey | null>(null);
  const lastVisitedSettingsCategoryRef = useRef(lastVisitedSettingsCategory);
  const cancelledRef = useRef(false);

  useEffect(() => {
    recencyStateRef.current = recencyState;
  }, [recencyState]);

  useEffect(() => {
    keybindingsRef.current = keybindings;
  }, [keybindings]);

  useEffect(() => {
    lastVisitedSettingsCategoryRef.current = lastVisitedSettingsCategory;
  }, [lastVisitedSettingsCategory]);

  const navigateToTarget = useCallback(
    (targetKey: TabTargetKey) => {
      const target = parseTabTargetKey(targetKey);
      if (!target) {
        return;
      }

      switch (target.kind) {
        case "thread":
          void navigate({
            to: "/$threadId",
            params: { threadId: target.threadId },
          });
          return;
        case "settings":
          void navigate({
            to: "/settings",
            search: {
              category: lastVisitedSettingsCategoryRef.current,
            },
          });
          return;
        case "planningWorkflow":
          void navigate({
            to: "/workflow/$workflowId",
            params: { workflowId: target.workflowId },
          });
          return;
        case "codeReviewWorkflow":
          void navigate({
            to: "/code-review/$workflowId",
            params: { workflowId: target.workflowId },
          });
      }
    },
    [navigate],
  );

  const commitCycleEnd = useCallback(
    (targetKey: TabTargetKey | null) => {
      const nextState = endCycle(recencyStateRef.current, targetKey);
      recencyStateRef.current = nextState.state;
      setRecencyState(nextState.state);

      const validTargetKey =
        targetKey && eligibleTargetKeySetRef.current.has(targetKey) ? targetKey : null;

      if (!validTargetKey || validTargetKey === currentTargetKeyRef.current) {
        return;
      }

      navigateToTarget(validTargetKey);
    },
    [navigateToTarget],
  );

  useEffect(() => {
    eligibleTargetKeysRef.current = eligibleTargetKeys;
    eligibleTargetKeySetRef.current = eligibleTargetKeySet;

    const activeTargetKey =
      getCycleTargetKey(recencyStateRef.current) ?? currentTargetKeyRef.current;
    const nextState = pruneRecentTabTargets(
      recencyStateRef.current,
      eligibleTargetKeys,
      activeTargetKey,
    );
    if (nextState !== recencyStateRef.current) {
      recencyStateRef.current = nextState;
      setRecencyState(nextState);
    }
  }, [eligibleTargetKeySet, eligibleTargetKeys]);

  useEffect(() => {
    currentTargetKeyRef.current = currentTargetKey;
    currentRouteThreadIdRef.current = currentRouteThreadId;

    if (currentRouteTargetKind === "settings" && currentRouteSettingsCategory) {
      lastVisitedSettingsCategoryRef.current = currentRouteSettingsCategory;
      setLastVisitedSettingsCategory((current) =>
        current === currentRouteSettingsCategory ? current : currentRouteSettingsCategory,
      );
    }

    const previousTargetKey = previousTargetKeyRef.current;
    const activeCycle = recencyStateRef.current.activeCycle;

    if (activeCycle) {
      const finalTargetKey = currentTargetKey ?? previousTargetKey;
      const nextState = endCycle(recencyStateRef.current, finalTargetKey).state;
      recencyStateRef.current = nextState;
      setRecencyState(nextState);
    }

    if (currentTargetKey && eligibleTargetKeySetRef.current.has(currentTargetKey)) {
      const nextState = recordTabTargetVisit(recencyStateRef.current, currentTargetKey);
      if (nextState !== recencyStateRef.current) {
        recencyStateRef.current = nextState;
        setRecencyState(nextState);
      }
    }

    previousTargetKeyRef.current = currentTargetKey;
  }, [
    currentRouteSettingsCategory,
    currentRouteThreadId,
    currentRouteTargetKind,
    currentTargetKey,
  ]);

  useEffect(() => {
    const resolveBinding = (event: KeyboardEvent) =>
      resolveShortcutBinding(event, keybindingsRef.current, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: currentTerminalOpen(currentRouteThreadIdRef.current),
        },
      });

    const consumeEvent = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (wsInteractionBlocked) return;

      const activeCycle = recencyStateRef.current.activeCycle;
      if (activeCycle) {
        if (event.key === "Escape") {
          consumeEvent(event);
          cancelledRef.current = true;
          commitCycleEnd(null);
          return;
        }

        const binding = resolveBinding(event);
        const direction = resolveCycleDirection(binding);
        if (!direction) {
          consumeEvent(event);
          return;
        }

        consumeEvent(event);

        const prunedState = pruneRecentTabTargets(
          recencyStateRef.current,
          eligibleTargetKeysRef.current,
          getCycleTargetKey(recencyStateRef.current) ?? currentTargetKeyRef.current,
        );
        if (prunedState !== recencyStateRef.current) {
          recencyStateRef.current = prunedState;
          setRecencyState(prunedState);
        }
        if (!recencyStateRef.current.activeCycle) {
          return;
        }

        const transition = advanceCycle(recencyStateRef.current, direction);
        if (!transition.targetKey) {
          return;
        }

        recencyStateRef.current = transition.state;
        setRecencyState(transition.state);
        return;
      }

      const binding = resolveBinding(event);
      const direction = resolveCycleDirection(binding);
      if (!binding || !direction) {
        return;
      }

      const prunedState = pruneRecentTabTargets(
        recencyStateRef.current,
        eligibleTargetKeysRef.current,
        currentTargetKeyRef.current,
      );
      if (prunedState !== recencyStateRef.current) {
        recencyStateRef.current = prunedState;
        setRecencyState(prunedState);
      }

      const transition = beginCycle(recencyStateRef.current, {
        direction,
        activeTargetKey: currentTargetKeyRef.current,
        eligibleTargetKeys: eligibleTargetKeysRef.current,
        shortcut: binding.shortcut,
      });
      if (!transition.targetKey) {
        return;
      }

      consumeEvent(event);
      recencyStateRef.current = transition.state;
      setRecencyState(transition.state);
      cancelledRef.current = false;

      if (!transition.state.activeCycle) {
        navigateToTarget(transition.targetKey);
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const activeCycle = recencyStateRef.current.activeCycle;
      if (!activeCycle) return;
      if (cancelledRef.current) {
        if (!areRequiredHeldModifiersPressed(activeCycle.heldModifiers, event)) {
          cancelledRef.current = false;
        }
        return;
      }
      if (areRequiredHeldModifiersPressed(activeCycle.heldModifiers, event)) return;
      commitCycleEnd(getCycleTargetKey(recencyStateRef.current));
    };

    const onBlur = () => {
      if (!recencyStateRef.current.activeCycle) return;
      commitCycleEnd(getCycleTargetKey(recencyStateRef.current));
    };

    const onVisibilityChange = () => {
      if (!recencyStateRef.current.activeCycle) return;
      if (!document.hidden) return;
      commitCycleEnd(getCycleTargetKey(recencyStateRef.current));
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [commitCycleEnd, navigateToTarget, wsInteractionBlocked]);

  const handlePickerSelect = useCallback(
    (targetKey: TabTargetKey) => {
      if (!recencyStateRef.current.activeCycle) return;
      commitCycleEnd(targetKey);
    },
    [commitCycleEnd],
  );

  const handlePickerDismiss = useCallback(() => {
    if (!recencyStateRef.current.activeCycle) return;
    commitCycleEnd(getCycleTargetKey(recencyStateRef.current));
  }, [commitCycleEnd]);

  const pickerItems = useMemo(() => {
    if (!recencyState.activeCycle) return [];

    const threadMap = new Map(threads.map((thread) => [thread.id, thread] as const));
    const projectMap = new Map(projects.map((project) => [project.id, project] as const));
    const planningWorkflowMap = new Map(
      planningWorkflows.map((workflow) => [workflow.id, workflow] as const),
    );
    const codeReviewWorkflowMap = new Map(
      codeReviewWorkflows.map((workflow) => [workflow.id, workflow] as const),
    );
    const showProject = projects.length > 1;

    return recencyState.activeCycle.order.map((targetKey) => {
      const target = parseTabTargetKey(targetKey);
      const isStale = !eligibleTargetKeySet.has(targetKey);

      if (target?.kind === "thread") {
        const thread = threadMap.get(target.threadId);
        const draftThread = draftThreadsByThreadId[target.threadId];
        const isDraft = isDraftThreadId(target.threadId, draftThreadsByThreadId);
        const projectId = thread?.projectId ?? draftThread?.projectId ?? null;

        return {
          id: targetKey,
          title: thread?.title ?? (isDraft ? DEFAULT_NEW_THREAD_TITLE : target.threadId),
          subtitle: showProject && projectId ? (projectMap.get(projectId)?.name ?? null) : null,
          badgeLabel: null,
          threadStatusPill: thread ? resolveThreadStatusPillForThread(thread) : null,
          isDraft,
          isStale,
        };
      }

      if (target?.kind === "settings") {
        return {
          id: targetKey,
          title: "Settings",
          subtitle: SETTINGS_CATEGORY_LABELS[lastVisitedSettingsCategory],
          badgeLabel: "Settings",
          threadStatusPill: null,
          isDraft: false,
          isStale,
        };
      }

      if (target?.kind === "planningWorkflow") {
        const workflow = planningWorkflowMap.get(target.workflowId);
        const projectName =
          showProject && workflow ? (projectMap.get(workflow.projectId)?.name ?? null) : null;

        return {
          id: targetKey,
          title: workflow?.title ?? fallbackTitleForTarget(target),
          subtitle: projectName,
          badgeLabel: "Feature",
          threadStatusPill: null,
          isDraft: false,
          isStale,
        };
      }

      if (target?.kind === "codeReviewWorkflow") {
        const workflow = codeReviewWorkflowMap.get(target.workflowId);
        const projectName =
          showProject && workflow ? (projectMap.get(workflow.projectId)?.name ?? null) : null;

        return {
          id: targetKey,
          title: workflow?.title ?? fallbackTitleForTarget(target),
          subtitle: projectName,
          badgeLabel: "Review",
          threadStatusPill: null,
          isDraft: false,
          isStale,
        };
      }

      return {
        id: targetKey,
        title: fallbackTitleForTarget(target),
        subtitle: null,
        badgeLabel: null,
        threadStatusPill: null,
        isDraft: false,
        isStale,
      };
    });
  }, [
    codeReviewWorkflows,
    draftThreadsByThreadId,
    eligibleTargetKeySet,
    lastVisitedSettingsCategory,
    planningWorkflows,
    projects,
    recencyState.activeCycle,
    threads,
  ]);

  const activeCycle = recencyState.activeCycle;
  if (!activeCycle) {
    return null;
  }

  return (
    <ThreadCyclePicker
      items={pickerItems}
      currentIndex={activeCycle.index}
      currentItemId={currentTargetKey}
      onSelect={handlePickerSelect}
      onDismiss={handlePickerDismiss}
    />
  );
}
