- `grep -n`/`rg -n` results in expanded command cards are grouped by file and highlighted when
  the output goes through `head`, `tail` or another `grep`/`rg` filter (such as `| grep -v test`),
  instead of showing as plain text.
