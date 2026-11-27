- Codex read-only workflow stages no longer run commands your Codex `allow` rules match without
  F5 checking them. Those stages use a Codex home without your `rules` folder, and a repository
  with its own `.codex/rules` can't run them.
