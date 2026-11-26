- Read-only workflow stages on Antigravity and Cursor refuse a command that asks to run outside
  the provider's sandbox, even when the command itself only reads. Before, an Antigravity
  reviewer could retry an allowed command such as `gh api zen` with `BypassSandbox` and reach
  the network from outside the sandbox.
