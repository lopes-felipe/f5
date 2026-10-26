# Upstream ports

Track the repository your project was forked from. F5 triages each new upstream commit into a
topic, you decide what to port in a few keystrokes, and **Start port** opens a worktree thread
with a prompt that carries the topic's commits and the trailer that completes it.

## How to

1. Add an `upstream` block to the project's checked-in `f5.json`:

   ```json
   {
     "upstream": {
       "repository": "https://github.com/pingdotgg/t3code",
       "remote": "upstream",
       "branch": "main"
     }
   }
   ```

2. Open **Upstream** in the sidebar. If the remote is missing, click **Add upstream remote**. F5
   adds it with pushes disabled.
3. Click **Run now**. F5 fetches the upstream branch and triages every commit after the last
   tracked one.
4. Review the **Inbox**: `j`/`k` to move, `a` to accept the suggestion, `p` to port, `s` to skip,
   `w` to watch, `d` to decline. Each decision is saved locally at once.
5. Select **Ready** topics and press `Shift+P` (**Start port**). Each thread opens in its own
   worktree on `f5/upstream-<topic>`.
6. Merge the ledger pull request F5 opens (**Track upstream t3code changes (<date>)**) whenever
   convenient. It only touches `upstream/` and needs no line review.

## The daily flow

- In the settings popover (gear icon), turn on the **Schedule** (daily or weekly, at a local
  hour). F5 runs at that time, catches up after sleep or a restart, retries a failed run after 10
  minutes, 30 minutes and 2 hours, and continues a large backlog every 5 minutes until it is
  covered. With F5 unfocused, a notification says how many new topics arrived.
- Suggestions show as chips such as `Port 0.92` or `Skip: mobile 0.97`. Confident skips with a
  known reason, no open question and no conflict are applied automatically (`decidedBy: llm`).
  **Skipped** with **Automatic only** lists them for spot checks.
- `?` marks an open question: the choice depends on a product preference that
  `upstream/policy.md` does not cover. Answer it in the policy so later runs stop asking.
- Add a **Scope note** before **Port** to limit a mixed commit to the parts you want.
- **Copy port prompt** puts the same prompt on the clipboard without creating a link, for a
  Feature workflow or any thread. The trailer still completes the topic once merged.

All shortcuts are listed in [Keybindings](../../KEYBINDINGS.md#upstream-page).

## States, trailers and epochs

| State       | Meaning                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| Inbox       | Waiting for a decision, or a watched topic past its revisit date                |
| Ready       | Marked to port, no active port thread                                           |
| In progress | A port thread for the current epoch is linked                                   |
| Watch       | Waiting for an unfinished upstream series; returns to Inbox after 30 days       |
| Done        | Equivalent already in f5, or a commit on the default branch carries the trailer |
| Skipped     | Skipped or declined                                                             |

A port is done when a commit on the default branch ends with `Upstream-Topic: <id>` (or
`Upstream-Topic: <id>#<epoch>` after a reopen). Port threads add the line to every commit and the
PR description.

Moving a topic back to Inbox or Watch from Port or Done increments its **epoch**. Older trailers
and port threads stop counting, and new upstream follow-ups can join the topic again. Follow-ups
to a topic that is already decided become new topics with a **Related** link instead.

When a port thread finishes, its last line is an outcome: `pr <url>`, `equivalent <path:line>`,
`not-applicable <reason>` or `blocked <reason>`. The detail pane offers **Record equivalent**,
**Record not applicable** and, for a blocked port, **Move to Watch**.

Before you start a port, the dialog warns when newer upstream commits are not triaged yet.
**Run now first** covers them so follow-ups and reverts are grouped before the port starts.

## Policy, rules and the legacy backlog

The ledger lives in `upstream/` by default; `ledgerDir` in the `f5.json` `upstream` block
moves it, and the paths below are then relative to that directory.

- `upstream/policy.md` is free text that both triage and port prompts include. Edit it like any
  other file; it may change together with code. Prompts include up to 16 KiB of it.
- `upstream/rules.json` holds reason keys, path rules that skip commits without the LLM (mobile,
  marketing, CI, docs, tests) and `autoSkipConfidence` (0.85).
- `upstream/archive/schema6.json` is the frozen earlier catch-up. Its deferred records are
  triaged through **Triage legacy backlog**. Records whose implementation commits are already on
  the default branch get an `Equivalent 0.70` suggestion you confirm with `a`.
- Never hand-edit `upstream/intervals`, `upstream/legacy` or `upstream/topics`.
  `bun run upstream-ports:check` rejects edits to coverage files and ledger changes mixed with
  code.

## Triage model

Triage runs without tools, MCP servers, slash commands or access to the repository, because
upstream commit text is untrusted. Only Claude instances guarantee that today, so the triage
model picker lists Claude instances only. With **Automatic**, F5 uses the project's text
generation model when it is Claude, otherwise the first enabled Claude instance. **Rules only**
runs without the LLM: every remaining commit becomes its own Inbox topic.

Calibration: one 20-commit batch was not yet measured on a release build. Run
`F5_UPSTREAM_TRIAGE_LIVE=1 node node_modules/vitest/vitest.mjs run apps/server/src/upstreamPorts/triageRun.live.test.ts`
and keep the default batch of 20 unless the median exceeds 90 seconds.

## Publication

Decisions and run results are saved in F5 first, then published to one rolling ledger pull
request. The banner shows its number, phase and unpublished changes.

| Banner                     | What to do                                                                       |
| -------------------------- | -------------------------------------------------------------------------------- |
| Signed out, push rejected  | Fix credentials or signing, then **Retry publish**                               |
| Closed without merging     | **Re-publish on a new PR**, or **Discard N changes**                             |
| Ledger changed elsewhere   | **Discard unpublished changes and resync**                                       |
| Managed by another profile | **Take over** (the other profile's unpublished changes are then never published) |

A pull request merged while F5 was pushing is detected by content; anything left over is
published on a new branch.

## Good to know

- One F5 profile on one machine writes the ledger for a repository. Other profiles see a
  read-only page with **Take over**. Writers on several machines are not supported.
- Only GitHub upstreams are supported.
- The schedule and model choices are personal settings. They are never read from `f5.json`.

## Related

- [Project configuration](../project-configuration.md)
- [Workflows](workflows.md)
- [Scripts: upstream port ledger](../scripts.md#upstream-port-ledger)
