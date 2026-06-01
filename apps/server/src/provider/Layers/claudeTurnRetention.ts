/**
 * Retention bound for the Claude per-session turn archive.
 *
 * `ClaudeSessionContext.turns` retains the full SDK message bodies for every
 * completed turn. Those bodies include the entire file contents from Write/Edit
 * tool calls and their tool results, so during long, file-writing sessions they
 * accumulate without bound and exhaust the backend heap. The per-turn
 * `approximateChars` accounting that drives compaction recommendations and the
 * resume cursor is tracked independently of the bodies, so the heavy `items`
 * can be dropped from the oldest turns without affecting any of that.
 *
 * The only reader of these bodies is `snapshotThread`/`readThread`. In
 * production that path is exercised solely by `codexSnapshotReconciliation`,
 * which bails out for non-codex bindings, so evicting Claude turn bodies has no
 * functional consumer today. NOTE: this is a non-local invariant — if a Claude
 * reconciliation/backfill path that consumes `readThread().turns[].items` is
 * ever added, it must not treat evicted (empty) turns as authoritative history.
 *
 * @module claudeTurnRetention
 */

/**
 * Total budget, in approximate characters, for retained turn-item bodies in a
 * single Claude session. Tunable: large enough that normal sessions retain full
 * fidelity, small enough that pathological file-writing sessions stay bounded.
 */
export const MAX_RETAINED_TURN_ITEM_CHARS = 2_000_000;

/**
 * Minimal shape required to enforce the retention budget. `items` is the heavy,
 * droppable body; `approximateChars` is the independently-maintained size proxy.
 */
export interface RetainableTurn {
  items: Array<unknown>;
  readonly approximateChars: number;
}

/**
 * Drops retained `items` bodies (replacing them with an empty array) from the
 * oldest turns until the total `approximateChars` of turns that still hold
 * bodies is within `budgetChars`. The most recent turn's body is always kept,
 * even if it alone exceeds the budget.
 *
 * Mutates `turns[i].items` in place. Never resizes `turns` and never touches
 * `approximateChars`, ids, or any other turn field, so callers that rely on
 * per-turn char accounting (compaction, resume cursor, rollback) are unaffected.
 */
export function enforceTurnItemBudget(
  turns: ReadonlyArray<RetainableTurn>,
  budgetChars: number = MAX_RETAINED_TURN_ITEM_CHARS,
): void {
  if (turns.length <= 1) {
    return;
  }

  let retainedChars = 0;
  for (const turn of turns) {
    if (turn.items.length > 0) {
      retainedChars += turn.approximateChars;
    }
  }

  if (retainedChars <= budgetChars) {
    return;
  }

  // Evict oldest-first while always preserving the most recent turn's body.
  const lastIndex = turns.length - 1;
  for (let index = 0; index < lastIndex && retainedChars > budgetChars; index += 1) {
    const turn = turns[index]!;
    if (turn.items.length === 0) {
      continue;
    }
    turn.items = [];
    retainedChars -= turn.approximateChars;
  }
}
