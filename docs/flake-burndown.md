# Flake burn-down

A runbook for fixing one `ci-flaky` issue per run. It is written for an agent started by an F5
scheduled task, and a person can follow it the same way. The rules it applies are the ones in
[CI quality gates](ci.md#flaky-tests): one PR per flake, and a green repro run on the OS where
the test flaked as evidence.

## Set it up

Create a scheduled task in F5 for this project with a fresh worktree per run and this prompt:

```text
Follow docs/flake-burndown.md and burn down one ci-flaky issue. Stop after one issue.
```

The run needs `gh` signed in with permission to dispatch workflows, push branches and open pull
requests. One run a day is enough: a run spends most of its time waiting for two repro
workflows of up to 90 minutes each.

## 1. Pick one issue

List the open issues with their occurrence counts:

```sh
gh issue list --label ci-flaky --state open --limit 300 --json number,title,createdAt,body
```

Take the issue with the highest `Occurrences:` number in its body, and the oldest one on a tie.
Skip an issue when either is true, and take the next:

- An open pull request mentions it: `gh pr list --state open --search '"#<number>" in:body'`.
- It has a comment that starts with `Burn-down:` from the last 14 days.

Issues titled `Flaky: suites/<name> did not finish` name no test. Skip them unless the
occurrence comments all point at the same test file.

## 2. Reproduce it on main

The issue title names the test file, and each occurrence comment gives the OS and the first
failure. Map them to the repro workflow's inputs:

| From the issue                               | `suite`              | `filter`                      |
| -------------------------------------------- | -------------------- | ----------------------------- |
| `apps/server/src/...`                        | `server-unit`        | the path after `apps/server/` |
| `apps/server/integration/git/...`            | `server-git`         | the path after `apps/server/` |
| `apps/server/integration/...`, anything else | `server-integration` | the path after `apps/server/` |
| `apps/web/....browser.tsx`                   | `web-browser`        | the path after `apps/web/`    |
| `Flaky step: desktop-smoke`                  | `desktop-smoke`      | none                          |

For `os`, use the OS with the most occurrences: `linux` is `ubuntu-latest`, `win32` is
`windows-latest` and `darwin` is `macos-latest`. Dispatch 30 repeats on main and wait for the
run:

```sh
gh workflow run ci-flake-repro.yml --ref main \
  -f os=<os> -f suite=<suite> -f filter=<file> -f repeats=30
gh run list --workflow ci-flake-repro.yml --limit 1 --json databaseId,url
gh run watch <id> --exit-status
```

The run's summary has a `Repeat: n/30 passed` line and a duration table.

- **It failed at least once.** Go to step 3 with the failing iteration's output.
- **30 of 30 passed.** Run it once more with `repeats=100`. If that is green too, comment on the
  issue and stop. Do not close it and do not change code:

  ```text
  Burn-down: not reproduced on <os> at <main sha>. 30/30 <run url>, 100/100 <run url>.
  ```

## 3. Find the cause

Read the failing iteration and the test before changing anything. Decide which of these it is,
and say so in the pull request:

- **The product is wrong.** The test caught a real race or platform difference. Fix the product
  and keep the assertion. #683 is the model: a Windows-only failure in `storagePathSafety` was
  inode numbers above 2^53 losing precision, not a timing problem.
- **The test is wrong.** It asserts on timing, order or shared state the product does not
  promise. Fix the test so it waits for the condition it checks.
- **The runner is too slow for the limit.** Only with the duration table from step 2 showing
  healthy iterations close to the limit. Raising a timeout without that table is not a fix.

Never make a flake pass by retrying, skipping or deleting the test, or by widening an assertion
until it cannot fail.

If the cause is not clear after reading the code and one more instrumented repro run, comment
what was ruled out, starting with `Burn-down:`, and stop.

## 4. Prove the fix

Create a branch named `fix/flake-<issue number>`, commit the fix and push it. Run the repro on
the branch with the same inputs:

```sh
gh workflow run ci-flake-repro.yml --ref fix/flake-<number> \
  -f os=<os> -f suite=<suite> -f filter=<file> -f repeats=30
```

30 of 30 is the bar. When main failed less often than once in 30, use `repeats=100`. A red run
means the fix is wrong or incomplete: go back to step 3.

Run the checks in [AGENTS.md](../AGENTS.md) before opening the pull request.

## 5. Open the pull request

One pull request for the one issue, with nothing else in it. The description says which of the
three causes it was, links the failing run on main and the green run on the branch, and ends
with `Fixes #<number>`. Add the `no-changelog` label unless the fix changes what a user sees,
in which case add a fragment under `changes/fixed/`.

Do not merge it. Stop here, even when time is left: the next run takes the next issue.
