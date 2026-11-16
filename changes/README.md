# Changelog fragments

Each user-visible change gets its own file here instead of a bullet in `CHANGELOG.md`.
Every PR adds a new file, so parallel PRs never conflict over the changelog.

```text
changes/<category>/<slug>.md
```

- `<category>` is one of `added`, `changed`, `performance`, `deprecated`, `removed`, `fixed` or
  `security`. The folder sets the `###` heading, so the file has no heading of its own.
- `<slug>` is a short name in lowercase letters, digits and dashes, for example
  `changes/fixed/bridge-unicode-separators.md`.
- The file holds one or more top-level `- ` bullets, written the way a user would notice the
  change. Indented lines continue a bullet; other text is rejected.

```markdown
- Agent Bridge tool calls whose text contains Unicode line or paragraph separators no longer fail
  with a parse error.
```

To change an entry that has not been released yet, edit its file. Only newly added fragments
satisfy the `Changelog` check; see CONTRIBUTING.md for when no entry is needed.

`bun run changelog:preview` prints what the next stable release will list. Stable release
preparation moves every fragment into a new `## [x.y.z]` section of `CHANGELOG.md`, in the order
the fragments landed on main, and deletes them. A fragment that lands while the preparation PR is
open ships with that release: its notes include it, and the next preparation adds it to that
release's section. Beta release notes list the entries added since the previous published release.

This README is never treated as a fragment.
