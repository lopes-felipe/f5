# PR Hub accounts and forges

Review and act on pull requests from GitHub, GitLab, Bitbucket Cloud, Azure DevOps and
Forgejo/Gitea without leaving F5. Each repository can use its own account.

> [!NOTE]
> This page has no screenshot because the PR Hub needs a connected forge account to show
> anything.

## How to

1. Open **Pull requests**. The queue lists the pull requests that involve you, grouped by what
   they need.
2. Select a row to read it in the side panel, or press <kbd>Enter</kbd> to open the whole pull
   request with its conversation, review threads and files.
3. Use the button at the end of a row for its next step, such as **Review**, **Fix CI** or
   **Merge**.

To add GitLab, Bitbucket Cloud, Azure DevOps, Forgejo/Gitea or another GitHub host:

1. Open the **⋯** menu in the Pull requests title bar and choose **Manage accounts**. It opens
   **Settings → Accounts → Forge accounts**.
2. Add a token for your forge host. F5 verifies it with the host before saving it. Azure DevOps
   also needs an organization.
3. If several accounts match a repository, add a repository route that picks one.

The profile's GitHub account stays the default. Once you add another account, a switcher
appears in the Pull requests title bar.

## The queue

The queue has one section per kind of work, in this order:

| Section               | What it holds                                                             |
| --------------------- | ------------------------------------------------------------------------- |
| **Review requested**  | Reviews requested from you, and new commits on pull requests you reviewed |
| **Your action**       | Your pull requests that need a fix: failing checks, conflicts, feedback   |
| **Ready to merge**    | Your pull requests that can merge now                                     |
| **Waiting on others** | Nothing for you to do until someone else acts                             |
| **Drafts**            | Your drafts                                                               |
| **Team queue**        | Reviews requested from one of your teams, and not from you                |
| **Other**             | Pull requests you are mentioned in or follow                              |
| **Stale**             | No activity for 30 days                                                   |

The last four start collapsed and load only when you open them. F5 remembers which sections you
opened. Each section loads 25 rows; **Show more** loads the next 25.

Each row shows the title, the repository and number, the author when it is not you, any linked
F5 thread with its live status, the review and check state, the size and the last update. The
button at the end is the next step for that pull request: **Review**, **Fix CI**, **Resolve
conflicts**, **Update branch**, **Address feedback**, **Merge** or **Mark ready**. **Fix CI**,
**Resolve conflicts** and **Address feedback** start an F5 thread on the pull request's branch;
when a linked thread is already working, the button reads **Open thread** instead.

Selecting a row opens the peek on the right: the next step, the review, checks and branch
status, the start of the description, and linked threads. <kbd>Enter</kbd>, a double-click or
**Open** shows the whole pull request, with **Summary**, **Timeline**, **Review threads**,
**Files** and **Guide · Beta** tabs. In a window too narrow for the peek, selecting a row opens
the pull request directly. The open pull request, its tab, the search and the filters are part
of the address, so Back, Forward and copied links restore them.

### Search and filters

The search field accepts qualifiers such as
`author:me draft:false review:approved status:success label:"needs design" -label:bug`, and
suggests qualifiers and their values as you type.
Use `repo:owner/name`, or `repo:name` alone, to keep one repository.
Repeat `label:` qualifiers to require all of them; comma-separated names match either label.
Prefix a supported qualifier with `-` to exclude matches. Unknown qualifiers remain search
text; unquoted words can match in any order, and quoted phrases stay together.

- Paste a pull request link into the search field and press <kbd>Enter</kbd> to open it, even
  if it is not in your queue. **Track a pull request by URL** in the **⋯** menu does the same.
- **Filter** narrows the queue by repository, author, label, checks, review decision or draft
  status. Each active filter shows as a chip you can remove.
- **Active**, **Snoozed**, **Ignored** and **Closed** switch between the queue and the pull
  requests you set aside or finished.

### Keyboard

These keys work on the Pull requests page when you are not typing in a field. They are also
listed in the keyboard shortcuts dialog.

| Key                                 | Action                                       |
| ----------------------------------- | -------------------------------------------- |
| <kbd>J</kbd> / <kbd>K</kbd>, arrows | Next or previous pull request                |
| <kbd>Space</kbd>                    | Open or close the peek                       |
| <kbd>Enter</kbd>                    | Open the pull request                        |
| <kbd>Esc</kbd>                      | Back to the queue                            |
| <kbd>/</kbd>                        | Search                                       |
| <kbd>A</kbd>                        | Run the row's next step                      |
| <kbd>M</kbd>                        | Merge                                        |
| <kbd>S</kbd>                        | Snooze or unsnooze                           |
| <kbd>E</kbd>                        | Ignore, or restore an ignored pull request   |
| <kbd>O</kbd>                        | Open on the forge                            |
| <kbd>R</kbd>                        | Refresh                                      |
| <kbd>[</kbd> / <kbd>]</kbd>         | Previous or next pull request, from its page |

### What the sidebar badge counts

The sidebar badge and notifications cover the first three sections: reviews requested from
you, your own pull requests that need a fix, and your pull requests that are ready to merge.
Within a section, the most recently updated pull request comes first.

- A review requested from one of your teams, and not from you, reads **Review requested from
  your team**. It goes to **Team queue** and never notifies. To treat a team's requests as
  your own, add it under **Settings → Git → Teams whose review requests are mine**, one
  `org/team` per line.
- A pull request with no activity for 30 days moves to **Stale**, and it comes back as soon as
  something happens on it. Change the period, or enter 0 to turn this off, under **Settings →
  Git → Move PRs to Stale after**.
- Your pull requests that have waited on others longer than **Settings → Git → Flag my PRs as
  stalled after** are marked **Stalled** in their row.
- **Ignore** shows an **Undo** button for a few seconds. Ignored pull requests remain under
  **Ignored**, where **Restore to the queue** brings one back.

## Safe actions

Every action that changes a pull request is prepared first. F5 shows the account and the exact
revision it will act on, and sends the action once you confirm. If a response gets lost,
**Check saved operation** looks for proof on the forge instead of sending again. Once you have
checked the forge yourself, **Acknowledge verified outcome** clears the operation without
resending it.

## Reviewing changes

Inline comments are tied to the exact head and base you compared. If either changes, refresh
before commenting. **Viewed** marks also belong to that revision, so a new push clears them.
Hover a PR link to preview it, copy it, or open it in the hub. **Send to agent** puts a diff
comment into the linked thread's composer without sending it.

Open **Guide · Beta** and select **Generate guide** for an ordered tour of the change.
Move between stops to read the excerpts, notes and review questions. A guide belongs to
the selected account and PR head. After a new push, F5 warns that the guide is stale and
hides its excerpts until you regenerate it. A failed regeneration keeps the previous tour.

In **Settings → Git → Guided PR reviews**, guides use your git text generation model
by default. Turn off **Use git text generation model** to select another provider,
model and reasoning options. Generating a guide sends the PR description, diff and
a bounded summary of settled review comments to that provider's account.

## What each forge supports

| Forge         | Comments | Approve / request changes | Branch updates | Merge         |
| ------------- | -------- | ------------------------- | -------------- | ------------- |
| GitHub        | Yes      | Yes                       | Yes            | Yes           |
| GitLab        | Yes      | Approve                   | Rebase         | Yes           |
| Bitbucket     | Yes      | Yes                       | No             | No            |
| Azure DevOps  | No       | No                        | No             | Merge, squash |
| Forgejo/Gitea | Yes      | Yes                       | Merge, rebase  | Yes           |

Only actions the forge advertises are shown, and GitHub permissions can narrow them further. Only
GitHub has native stacks.

## Good to know

- Tokens stay in the profile's server secret store and never reach the browser.
- Removing an account also removes its repository routes and stored token.
- When a refresh fails, cached data stays visible with a warning. Work that F5 finishes on its
  own, such as searches waiting for GitHub's request budget, is not a failure. Click the sync
  status in the title bar to see what is left, the next sync, rate limits and what is
  monitored, or to refresh now.
- PR markdown can show authenticated GitHub images and videos. Other HTML is escaped.

<details>
<summary>Details and limits</summary>

- Tokens are stored per host, verified login and credential generation. Replacing a token resets
  that account's runtime and caches. Selecting an account never changes a process-wide
  credential.
- Monitoring and request budgets are owned by the server and account, not by an open panel. Reads,
  pagination and account runtimes are bounded.
- An unresolved operation blocks preparing another change for that pull request. Outstanding
  operations are shown in every panel and client.
- GitLab and Bitbucket reviews save the comment and the verdict as separate steps, so a recovered
  comment is never mistaken for an accepted verdict. Stack actions check each layer's revision
  and keep partial progress.
- Bitbucket merges are disabled because its endpoint can't enforce the prepared head commit.
  Forgejo has no review-thread reply/resolve or draft conversion.
- Azure reviewer replacement adds new reviewers before removing old ones. These calls aren't
  atomic, so check the reviewer list after an interruption.
- GitHub stores viewed marks on the host; other forges store them in F5.
- The media proxy allows GitHub user attachments, GitHubusercontent hosts and configured
  Enterprise hosts. Tokens go only to their own host, including through redirects. Media is
  limited to 100 MB and supports single byte ranges.
- Stacks are hidden on hosts that return 404 or 422.
- A thread can link several pull requests, even from different forges.

</details>

## PR watches

Open a linked PR's menu in the thread header and select **Watch**. The eye button
stops that watch. Agents can use `watch_pull_request` with a PR URL or F5 key;
omitting the target uses the thread's single linked PR. `unwatch_pull_request`
without a target stops every watch in the current thread.

Watches run on the server every two minutes and queue an automatic follow-up when
checks, conflicts or review activity change. They share reads for the same account
and PR. Nothing starts watching by default. Stop, archive and PR closure end a watch.
Rate limits pause it; eight consecutive read failures end it with a thread notice.
Ten consecutive comment-only updates also end it to prevent bot loops. Forge
capabilities determine which check and review facts are available.

## Related

- [Project settings](project-settings.md) (per-project merge method)
- [Worktrees and storage automation](worktrees-and-storage-automation.md)

## PR links beside a thread

Click a PR link in a conversation or its linked-PR header to open a PR tab beside
that thread. Your conversation and draft stay in place. Merge, review and other
confirmations stay inside the panel and still require an explicit confirmation.
You can close, reorder and reopen the PR tab like other panel tabs.

Command-click, Control-click and middle-click always open the system browser.
Enable **Settings → Browser → Open pull request links on the forge** to use the
system browser for ordinary PR clicks too. **Open on forge** is always available
in the PR panel. Without a current thread, ordinary clicks open the in-app PR page.
The panel uses the selected forge account; connect or select a matching account
in **Pull requests** if a read is refused. Failed reads offer **Retry**.

In **Review threads → Filter comments**, choose whether to show bot comments and
resolved conversations. These choices persist locally. A thread with hidden bot
comments keeps **Load more comments** available for unloaded human replies.
Host restrictions on individual comments and threads can disable editing or
resolution even when the repository generally supports them.

Drag a linked PR from the thread header into the composer to add a PR context chip.
It keeps the PR URL in your draft and sends that reference only when you submit
the prompt. Deleting the chip removes the reference; undo restores it.

## Merge-message attribution

**Settings → Git → Remove agent credits when merging** is off by default. Enable
it to remove recognized agent co-author and generated-by lines from new GitHub
merge and squash commit messages, including auto-merge. Human co-authors, quoted
examples and original commits retain their text. Merge queues and native stack
merges keep their host-generated messages. The setting applies to this profile;
other forges retain their existing merge-message behavior.

## Quick actions and row menus

Hold **Shift** without another modifier to show quick actions in the PR inbox and
on linked PRs in the thread header. Right-click either row to open its action menu.
Linked PR menus also include **Copy link**, **Open in F5**, **Open on forge** and
**Watch**.

A quick action opens its confirmation view; it does not send a remote change.
Linked PRs load their current state when opened, and unavailable actions are
refused. **Prepare** shows the saved operation and **Confirm** submits it once.
Only actions supported by that forge are offered. Releasing Shift, changing
modifiers or leaving the window hides quick actions.
