import type { KeybindingShortcut } from "@t3tools/contracts";

import type { TabTargetKey } from "./tabTargets";
import { isMacPlatform } from "./lib/utils";

export interface ThreadRecencyHeldModifiers {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface ThreadRecencyCycle {
  order: TabTargetKey[];
  index: number;
  heldModifiers: ThreadRecencyHeldModifiers;
}

export interface ThreadRecencyState {
  recentTargetKeys: TabTargetKey[];
  activeCycle: ThreadRecencyCycle | null;
}

export interface ThreadRecencyTransition {
  state: ThreadRecencyState;
  targetKey: TabTargetKey | null;
  commitTargetKey: TabTargetKey | null;
}

interface BeginCycleOptions {
  direction: "next" | "previous";
  activeTargetKey: TabTargetKey | null;
  eligibleTargetKeys: ReadonlyArray<TabTargetKey>;
  shortcut: KeybindingShortcut;
  platform?: string;
}

export const EMPTY_THREAD_RECENCY_STATE: ThreadRecencyState = Object.freeze({
  recentTargetKeys: [],
  activeCycle: null,
});

function orderedUniqueTargetKeys(targetKeys: ReadonlyArray<TabTargetKey>): TabTargetKey[] {
  const seen = new Set<TabTargetKey>();
  const ordered: TabTargetKey[] = [];

  for (const targetKey of targetKeys) {
    if (seen.has(targetKey)) continue;
    seen.add(targetKey);
    ordered.push(targetKey);
  }

  return ordered;
}

function hasHeldModifiers(heldModifiers: ThreadRecencyHeldModifiers): boolean {
  return (
    heldModifiers.ctrlKey || heldModifiers.metaKey || heldModifiers.altKey || heldModifiers.shiftKey
  );
}

function sameHeldModifiers(
  left: ThreadRecencyHeldModifiers,
  right: ThreadRecencyHeldModifiers,
): boolean {
  return (
    left.ctrlKey === right.ctrlKey &&
    left.metaKey === right.metaKey &&
    left.altKey === right.altKey &&
    left.shiftKey === right.shiftKey
  );
}

function sameTargetKeys(
  left: ReadonlyArray<TabTargetKey>,
  right: ReadonlyArray<TabTargetKey>,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameActiveCycle(
  left: ThreadRecencyCycle | null,
  right: ThreadRecencyCycle | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.index === right.index &&
    sameTargetKeys(left.order, right.order) &&
    sameHeldModifiers(left.heldModifiers, right.heldModifiers)
  );
}

function cycleIndexForDirection(
  direction: "next" | "previous",
  currentIndex: number,
  length: number,
): number {
  if (length === 0) return -1;
  return direction === "next" ? (currentIndex + 1) % length : (currentIndex - 1 + length) % length;
}

function requiredHeldModifiers(
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): ThreadRecencyHeldModifiers {
  const useMetaForMod = isMacPlatform(platform);
  return {
    ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod),
    metaKey: shortcut.metaKey || (shortcut.modKey && useMetaForMod),
    altKey: shortcut.altKey,
    shiftKey: shortcut.shiftKey,
  };
}

function buildCycleOrder(
  recentTargetKeys: ReadonlyArray<TabTargetKey>,
  eligibleTargetKeys: ReadonlyArray<TabTargetKey>,
  activeTargetKey: TabTargetKey | null,
): TabTargetKey[] {
  const eligibleTargetKeySet = new Set(eligibleTargetKeys);
  const orderedEligible = orderedUniqueTargetKeys(
    recentTargetKeys.filter((targetKey) => eligibleTargetKeySet.has(targetKey)),
  );

  if (activeTargetKey && eligibleTargetKeySet.has(activeTargetKey)) {
    return [
      activeTargetKey,
      ...orderedEligible.filter((targetKey) => targetKey !== activeTargetKey),
    ];
  }

  return orderedEligible;
}

export function recordTabTargetVisit(
  state: ThreadRecencyState,
  targetKey: TabTargetKey,
): ThreadRecencyState {
  const recentTargetKeys = [
    targetKey,
    ...state.recentTargetKeys.filter((entry) => entry !== targetKey),
  ];
  return sameTargetKeys(recentTargetKeys, state.recentTargetKeys)
    ? state
    : { ...state, recentTargetKeys };
}

export function pruneRecentTabTargets(
  state: ThreadRecencyState,
  eligibleTargetKeys: ReadonlyArray<TabTargetKey>,
  activeTargetKey: TabTargetKey | null,
): ThreadRecencyState {
  const eligibleTargetKeySet = new Set(eligibleTargetKeys);
  const recentTargetKeys = orderedUniqueTargetKeys(
    state.recentTargetKeys.filter((targetKey) => eligibleTargetKeySet.has(targetKey)),
  );

  let activeCycle = state.activeCycle;
  if (activeCycle) {
    const order = activeCycle.order.filter((targetKey) => eligibleTargetKeySet.has(targetKey));
    const minimumCycleLength = activeTargetKey ? 2 : 1;
    if (order.length < minimumCycleLength) {
      activeCycle = null;
    } else if (activeTargetKey) {
      const index = order.indexOf(activeTargetKey);
      activeCycle =
        index === -1
          ? null
          : {
              order,
              index,
              heldModifiers: activeCycle.heldModifiers,
            };
    } else {
      const index = Math.min(activeCycle.index, order.length - 1);
      activeCycle = {
        order,
        index,
        heldModifiers: activeCycle.heldModifiers,
      };
    }
  }

  if (
    sameTargetKeys(recentTargetKeys, state.recentTargetKeys) &&
    sameActiveCycle(activeCycle, state.activeCycle)
  ) {
    return state;
  }

  return { recentTargetKeys, activeCycle };
}

export function beginCycle(
  state: ThreadRecencyState,
  options: BeginCycleOptions,
): ThreadRecencyTransition {
  const order = buildCycleOrder(
    state.recentTargetKeys,
    options.eligibleTargetKeys,
    options.activeTargetKey,
  );
  const heldModifiers = requiredHeldModifiers(options.shortcut, options.platform);

  if (options.activeTargetKey) {
    if (order.length < 2) {
      return { state, targetKey: null, commitTargetKey: null };
    }
    const activeIndex = order.indexOf(options.activeTargetKey);
    const baseIndex = activeIndex === -1 ? 0 : activeIndex;
    const index = cycleIndexForDirection(options.direction, baseIndex, order.length);
    const targetKey = order[index] ?? null;
    if (!targetKey) {
      return { state, targetKey: null, commitTargetKey: null };
    }
    if (!hasHeldModifiers(heldModifiers)) {
      const nextState = recordTabTargetVisit({ ...state, activeCycle: null }, targetKey);
      return { state: nextState, targetKey, commitTargetKey: targetKey };
    }
    return {
      state: {
        ...state,
        activeCycle: {
          order,
          index,
          heldModifiers,
        },
      },
      targetKey,
      commitTargetKey: null,
    };
  }

  const targetKey = order[0] ?? null;
  if (!targetKey) {
    return { state, targetKey: null, commitTargetKey: null };
  }
  if (!hasHeldModifiers(heldModifiers)) {
    const nextState = recordTabTargetVisit({ ...state, activeCycle: null }, targetKey);
    return { state: nextState, targetKey, commitTargetKey: targetKey };
  }
  return {
    state: {
      ...state,
      activeCycle: {
        order,
        index: 0,
        heldModifiers,
      },
    },
    targetKey,
    commitTargetKey: null,
  };
}

export function advanceCycle(
  state: ThreadRecencyState,
  direction: "next" | "previous",
): ThreadRecencyTransition {
  const activeCycle = state.activeCycle;
  if (!activeCycle || activeCycle.order.length === 0) {
    return { state, targetKey: null, commitTargetKey: null };
  }

  const index = cycleIndexForDirection(direction, activeCycle.index, activeCycle.order.length);
  const targetKey = activeCycle.order[index] ?? null;
  if (!targetKey) {
    return { state, targetKey: null, commitTargetKey: null };
  }

  return {
    state: {
      ...state,
      activeCycle: {
        ...activeCycle,
        index,
      },
    },
    targetKey,
    commitTargetKey: null,
  };
}

export function getCycleTargetKey(state: ThreadRecencyState): TabTargetKey | null {
  return state.activeCycle?.order[state.activeCycle.index] ?? null;
}

export function endCycle(
  state: ThreadRecencyState,
  finalTargetKey: TabTargetKey | null,
): ThreadRecencyTransition {
  if (!state.activeCycle) {
    return { state, targetKey: null, commitTargetKey: null };
  }

  const clearedState = { ...state, activeCycle: null };
  if (!finalTargetKey) {
    return { state: clearedState, targetKey: null, commitTargetKey: null };
  }

  return {
    state: recordTabTargetVisit(clearedState, finalTargetKey),
    targetKey: null,
    commitTargetKey: finalTargetKey,
  };
}
