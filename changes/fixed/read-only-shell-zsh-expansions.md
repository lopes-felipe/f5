- Read-only workflow stages no longer approve a command that uses a variable as `$NAME:…` or
  `$NAME[…]`. zsh, which agents run commands in, reads those as modifiers that can rewrite the
  value into a flag that writes files. Write `${NAME}` with braces instead. `nl` is now allowed.
