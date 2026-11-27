- A thread whose worktree is not on disk now restores it on your next message without asking,
  and the timeline says what happened: "Worktree restored on `topic`", "`topic` no longer
  existed; recreated from `main` at `abc1234`" when the branch was gone too, or "Worktree moved
  to `<folder>`" when the old folder now holds something else (that folder is left untouched).
  A branch that is gone locally but still on a remote is restored from that remote copy
  ("Worktree restored on `topic` from `origin/topic`"), not from the default branch.
  The **Recreate now**, **Recreate from `<default branch>`** and header **Recreate worktree**
  controls are gone; the header shows **Worktree restores on send** instead, and **Worktree not
  on disk** when you have to decide first.
- Everything about a thread's workspace now appears in one card above the composer, replacing
  the workspace-switch banner, the missing-worktree banner and the queue's own workspace
  messages, which could disagree and repeat each other. The card shows one line while a
  worktree is being created, restored or switched, and asks only when you have to decide:
  **Continue there** or **New worktree** when another checkout has the thread's branch, and
  **Try again** or **Continue in Local** when a restore failed. **Continue there** is offered
  only for the project folder and worktrees F5 manages, and the card says how many other
  threads already use that folder. After a worktree setup failed, **Try again** and **Continue
  in Local** now release the waiting message instead of being refused.
- Cancelling an automatic restore leaves the message waiting; the restore does not start again
  on its own.
- A queue paused by an earlier version because a worktree was missing stays paused across
  restarts while the worktree is still missing: nothing waiting is sent until you choose
  **Try again** or **Continue in Local**. It is released only when the worktree is back.
