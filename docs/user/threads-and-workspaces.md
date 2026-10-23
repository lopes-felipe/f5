# Threads and workspaces

A thread is one conversation with one agent in one workspace. The agent edits files in the
workspace you choose, and F5 records its commands, file changes and plans so you can inspect them
afterwards.

![Chat thread with commands, file changes and the diff panel open on a new Postgres adapter](../../assets/screenshots/thread.png)

## How to

1. Click **New thread** (`mod+N`) or type in the box on Home.
2. Pick the **provider and model** from the model chip, and **traits** such as reasoning effort.
3. Pick **Access**, the thread's [runtime mode](../runtime-modes.md).
4. Choose **Agent** or **Plan**. Plan asks for a plan you can accept or revise before any change.
5. Choose the **workspace**: **Local** (the project checkout) or a
   [worktree](worktrees-and-storage-automation.md) with its own branch and directory.
6. Send your message.

The composer also takes [attachments](attachments-and-media.md), `@` file mentions and `/`
commands, including provider and project skills. The context ring shows how full the model's
context window is.

## While the agent works

In Supervised and Auto-accept edits modes the agent stops for approval, and its questions wait for
your answer. Where the provider supports it, a message sent mid-turn can steer the turn instead of
waiting (**Settings → Threads → Follow-up behavior**). **Stop generation** ends the turn.

Queued messages appear above the composer. You can pause the queue, reorder it, run one now, edit,
duplicate or cancel it. The queue is stored on the server, so it survives restarts.

## Panels

The right side of a thread holds the **Agents**, **Diff**, **Plan**, **Files** and **Preview**
panels; open them from the panel picker or their shortcuts. The terminal (`mod+J`) opens below the
thread in the workspace directory, and project scripts run from the thread header.

In the terminal, Shift+PageUp and Shift+PageDown page through scrollback. `mod+Shift+Home` and
`mod+Shift+End` jump to the start and the latest output; full-screen programs keep those keys.
Cmd+A on macOS and Ctrl+Shift+A elsewhere select all retained output, while Ctrl+A still moves to
the start of shell input.

The Files panel can edit files. If a file changes on disk while you have unsaved edits, F5 marks a
conflict and keeps your draft. **Open in editor** hands the file to your external editor.

## Review changes and rewind

Each turn lists its changed files with line counts, and **View diff** opens the Diff panel for that
turn. F5 records a checkpoint after each turn; on providers that support it, you can revert the
thread to an earlier message, which restores the files. Stop the agent before reverting.

## Git

Threads show their branch. From the thread header you can create branches, open worktrees and run
commit, push and pull request actions. Linked pull requests also appear in the
[Pull Requests hub](pr-hub-forges.md).

## Good to know

> [!NOTE]
> **Thread summaries** (**Settings → Threads**) send thread messages, activities, plans, tasks and
> checkpoints to the account you choose, including threads that ran on other providers.

- **Home** groups threads into Pinned, Needs you, Working and Recent. `mod+K` searches threads,
  workflows and commands.
- Archive a thread from its sidebar menu; archived items are under **Settings → Archive**.
- A usage-limit notice can be snoozed until a time you pick; snoozed threads show a moon icon.
- A turn running during a restart resumes only if **Settings → Threads → Resume active turns after
  restart** is on (off by default).

<details>
<summary>Panels in detail</summary>

| Panel   | What it shows                                                                   |
| ------- | ------------------------------------------------------------------------------- |
| Agents  | Subagents and background workflows started from the thread                      |
| Diff    | Files the thread changed, per turn or for a recorded file change                |
| Plan    | The current implementation plan                                                 |
| Files   | The workspace file tree and a file viewer with editing                          |
| Preview | The built-in browser, in desktop builds ([preview browser](preview-browser.md)) |

New threads default to **Full access**; change the default under **Settings → Threads → Default
permissions** or per project. Resumed turns show "Resuming after restart", and projects can
override the resume setting.

</details>

## Related

- [Getting started](getting-started.md)
- [Agent tools](agent-tools.md)
- [Workflows](workflows.md)
- [Keybindings](../../KEYBINDINGS.md)

## Panel tabs

Drag a tab to change its order. **Mod+T** opens a searchable list of the thread's
open panel tabs; Enter selects a result and Escape closes the list.
**Mod+Shift+T** reopens the last closed tab, including its file location. F5
remembers up to 20 closed tabs per thread for the current app session. Closing
others, closing to the right and closing all also add to that history. Hiding
the entire panel keeps its tabs open.

In **Settings → Appearance → Conversation width**, select **Full** to use the
available conversation width. Messages, the composer and conversation banners
use the same width preference.

Reasoning effort can also be stepped with the **Increase reasoning effort** and
**Decrease reasoning effort** commands in keyboard settings. Both start unbound.
They move through the selected model's supported levels, wrapping at either end,
and keep the draft text, mode and other model options intact.

In an existing thread's composer, **Mod+Alt+Enter** sends your message and opens
a project draft after the server accepts it. A failed submission keeps you in the
original thread with your text restored. A thread you leave while waiting for
acceptance does not pull you back. **Steer active turn** remains available as a
custom binding; it no longer shares that default shortcut.

## Diagrams and shell commands

Settled `mermaid` code blocks render a diagram when they come into view. **Show
code** keeps the original source available in place, including when rendering
fails. Diagrams follow the app's light or dark theme; diagram scripts and links
are inactive. Large diagrams can remain as source.

Complete shell fences offer **Run in terminal** in a connected thread. Execution
starts only when you click. F5 opens a fresh terminal in the thread workspace so
it preserves commands already typed in other terminals. Streaming, unfinished,
empty or concealed-control-character blocks cannot run through this action.

## Settle completed work

Choose **Settle** in a thread's menu to keep completed work in the project's
collapsed **Settled** group. The conversation stays searchable and opens at its
existing address. **Unsettle** returns it to the active list. A new message, turn
or queued wake also brings it back before the work starts. The unbound
**Toggle thread settlement** keyboard command can be assigned in keyboard settings.
The project menu's **Settle idle threads** leaves running, pinned, snoozed and
pending work alone.

Automatic settlement is off by default. In **Settings → Git & GitHub → Thread
settlement**, enable resolved-PR settlement or choose an inactivity period from
1 to 365 days. Project settings can override these choices. Resolved-PR settlement
requires every linked PR to be merged or closed after your latest human message
or wake. Old merges do not immediately settle a conversation you just unsettled.
The inactivity rule keeps linked PR threads unless you disable that preference.
The header's **Auto-settle** switch lets one thread opt out of enabled rules.

Running turns, unfinished terminal processing, pending approvals or questions,
queued work, background work and active PR watches prevent automatic settlement.
An explicit manual settlement stops its PR watches. F5 closes idle terminals only
when a fresh process check proves they have no live children; terminal history is
retained. Agents can explicitly request settlement with **thread_settle**. During
a turn, that request waits until processing finishes; Stop or a new message
cancels it.
