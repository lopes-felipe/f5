- Worktree setup that a restart interrupted before the agent started now resumes by itself
  instead of failing and pausing the queue. Checkout and submodules that already finished are
  not repeated.
- A background setup script that a restart cut off no longer holds the thread. The setup card
  marks it "interrupted by a restart", the agent starts, and a new **Rerun setup script** button
  runs it again when you want; the button also appears after a setup script fails. With **Agent
  waits** on, F5 reruns the script once by itself.
- Checkout waits and tries again, up to three times, when another F5 window is using the
  repository, instead of failing the setup at once.
- The setup card's actions are renamed and reordered: **Cancel** while setup runs, then
  **Retry**, **Continue in Local** (was **Work locally**) and **Discard message** (was
  **Discard**) after a failure.
