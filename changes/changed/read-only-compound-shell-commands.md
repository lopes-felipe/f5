- Read-only workflow stages on Cursor and Antigravity accept `if`/`elif`/`else` blocks, `{ …; }`
  groups and `( … )` subshells when every command inside only reads, such as
  `if [ -d repo/.git ]; then git -C repo status; else echo "No repo"; fi`. Loops, `case` and
  functions are still refused.
