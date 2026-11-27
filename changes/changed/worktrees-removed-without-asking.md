- Deleting threads now removes their worktrees without a dialog when nothing can be lost: the
  tree is clean, no other thread uses the worktree, and its only ignored files are build and
  cache output such as `node_modules/` or `dist/`. The branch is always kept, and a toast says
  "Removed N worktrees · branches kept". The removal dialog opens only for the worktrees that
  need a decision.
- In the removal dialog, build and cache output no longer needs its own confirmation checkbox.
  The checkbox appears only when other ignored files, such as `.env`, would be deleted.
- The workspace picker says **`<branch>` · restores on send** instead of **· missing** for a
  worktree that is not on disk, and **Creating worktree…** while a first send sets one up.
  **Manage** gains **Restore worktree now** for when you want the files back before sending.
