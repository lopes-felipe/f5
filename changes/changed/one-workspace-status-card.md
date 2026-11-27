- A thread whose worktree is not on disk now restores it on your next message without asking,
  and the timeline says what happened: "Worktree restored on `topic`", "`topic` no longer
  existed; recreated from `main` at `abc1234`" when the branch was gone too, or "Worktree moved
  to `<folder>`" when the old folder now holds something else (that folder is left untouched).
  The **Recreate now**, **Recreate from `<default branch>`** and header **Recreate worktree**
  controls are gone; the header shows **Worktree restores on send** instead.
- Everything about a thread's workspace now appears in one card above the composer, replacing
  the workspace-switch banner, the missing-worktree banner and the queue's own workspace
  messages, which could disagree and repeat each other. The card shows one line while a
  worktree is being created, restored or switched, and asks only when you have to decide:
  **Continue there** or **New worktree** when another checkout has the thread's branch, and
  **Try again** or **Continue in Local** when a restore failed.
- A queue paused by an earlier version because a worktree was missing is released on the next
  start, so its message gets the automatic restore.
