- Worktree setup that a restart interrupted before the agent started now resumes by itself
  instead of failing and pausing the queue. Checkout and submodules that already finished are
  not repeated; submodules that a restart cut off are initialized again.
- A background setup script that a restart cut off no longer holds the thread. The setup card
  marks it "interrupted by a restart", the agent starts, and a new **Rerun setup script** button
  runs it again when you want; the button also appears after a setup script fails. With **Agent
  waits** on, F5 reruns the script once by itself, whether the server was killed or shut down.
- A setup that resumes by itself never runs a setup command that was edited in the meantime:
  it stops and waits for **Retry**. In a project made of several repositories, a script that a
  restart cut off is never run again unasked.
- **Stop script** stops a setup script that is still running after the agent started, including
  one you asked to run again. **Rerun setup script** now says so when there is nothing to run.
- Checkout waits and tries again, up to three times, when another F5 window is using the
  repository, instead of failing the setup at once. This now also covers projects made of
  several repositories and projects with a worktree layout command.
- The setup card's actions are renamed and reordered: **Cancel** while setup runs, then
  **Retry**, **Continue in Local** (was **Work locally**) and **Discard message** (was
  **Discard**) after a failure.
