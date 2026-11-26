- New and renamed MCP servers may use letters, numbers, `_` and `-`, and must not start with `f5_`
  or `__f5`. Existing servers keep their names and show a rename warning, and import proposes a
  valid name.
- Importing MCP configuration now warns when a value contains a `${VAR}` reference, which F5 passes
  to the server literally.
