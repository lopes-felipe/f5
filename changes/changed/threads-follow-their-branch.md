- A thread now follows whatever branch its folder is on. When the agent (or you) switches
  branches or leaves a detached HEAD, the next message is sent without a "Thread branch changed"
  dialog or a drift banner, the workspace picker shows the live branch, and the timeline notes
  "Now on `<branch>` (was `<branch>`)". **Switch branch here…** in the picker still switches back.
- Switching a worktree's branch in place is now refused only by live use (a running or queued
  turn, setup, an open terminal or a starting agent), as in the project folder. Idle threads
  sharing the worktree no longer block it.
- The **Follow worktree branch switches** setting is gone: following is always on.
