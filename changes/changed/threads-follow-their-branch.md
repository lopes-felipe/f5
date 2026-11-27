- A thread now follows whatever branch its folder is on. When the agent (or you) switches
  branches or leaves a detached HEAD, the next message is sent without a "Thread branch changed"
  dialog or a drift banner, the workspace picker shows the live branch, and the timeline notes
  "Now on `<branch>` (was `<branch>`)". **Switch branch here…** in the picker still switches back.
- Every thread that shares a worktree follows it, including idle ones: each gets the new branch
  recorded and its own timeline note. This used to need the **Follow worktree branch switches**
  setting, which is gone: following is always on.
- Switching a worktree's branch in place is now refused only by live use (a running or queued
  turn, setup, an open terminal or a starting agent), as in the project folder. Idle threads
  sharing the worktree no longer block it, and they are re-recorded with the switch.
- In a project with several repositories, a thread follows its main checkout. A nested checkout
  left on another branch keeps that branch, and is restored on it.
- A queue that an older version paused because the worktree was on another branch is released
  when F5 starts and finds the worktree in place.
