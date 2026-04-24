# Keybindings

F5 reads keybindings from its local keybindings file:

- `~/.f5/keybindings.json`

The file must be a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

See the full schema for more details: [`packages/contracts/src/keybindings.ts`](packages/contracts/src/keybindings.ts)

## Defaults

```json
[
  { "key": "mod+j", "command": "terminal.toggle" },
  { "key": "mod+d", "command": "terminal.split", "when": "terminalFocus" },
  { "key": "mod+n", "command": "terminal.new", "when": "terminalFocus" },
  { "key": "mod+w", "command": "terminal.close", "when": "terminalFocus" },
  { "key": "mod+d", "command": "diff.toggle", "when": "!terminalFocus" },
  { "key": "mod+n", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+shift+n", "command": "workflow.new", "when": "!terminalFocus" },
  { "key": "mod+enter", "command": "chat.scrollToBottom" },
  { "key": "mod+o", "command": "editor.openFavorite" },
  { "key": "ctrl+tab", "command": "thread.switchRecentNext" },
  { "key": "ctrl+shift+tab", "command": "thread.switchRecentPrevious" },
  { "key": "alt+tab", "command": "model.switchRecent" },
  { "key": "mod+k", "command": "commandPalette.toggle", "when": "!terminalFocus" }
]
```

For most up to date defaults, see [`DEFAULT_KEYBINDINGS` in `apps/server/src/keybindings.ts`](apps/server/src/keybindings.ts)

## Recent Changes

- `mod+shift+n` now opens a new workflow by default.
- `mod+enter` now scrolls to the bottom instead of sending a message.
- `chat.newLocal` is still configurable, but it no longer has a default binding.

## Configuration

### Rule Shape

Each entry supports:

- `key` (required): shortcut string, like `mod+j`, `ctrl+k`, `cmd+shift+d`
- `command` (required): action ID
- `when` (optional): boolean expression controlling when the shortcut is active

Invalid rules are ignored. Invalid config files are ignored. Warnings are logged by the server.

### Available Commands

- `terminal.toggle`: open/close terminal drawer
- `terminal.split`: split terminal (in focused terminal context by default)
- `terminal.new`: create new terminal (in focused terminal context by default)
- `terminal.close`: close/kill the focused terminal (in focused terminal context by default)
- `diff.toggle`: toggle the diff panel
- `chat.new`: create a new chat thread preserving the active thread's branch/worktree state
- `chat.newLocal`: create or reuse the active project's draft thread
- `workflow.new`: open the workflow creation dialog for the active project
- `chat.scrollToBottom`: scroll the active chat to the latest message without sending
- `editor.openFavorite`: open current project/worktree in the last-used editor
- `thread.switchRecentNext`: cycle to the next recent tab/page (`Ctrl+Tab` by default). This now includes thread tabs, workflow pages, and settings.
- `thread.switchRecentPrevious`: cycle to the previous recent tab/page (`Ctrl+Shift+Tab` by default)
- `model.switchRecent`: cycle to the next recent model (`Alt+Tab` by default)
- `commandPalette.toggle`: open or close the command palette
- `script.{id}.run`: run a project script by id (for example `script.test.run`)

### Key Syntax

Supported modifiers:

- `mod` (`cmd` on macOS, `ctrl` on non-macOS)
- `cmd` / `meta`
- `ctrl` / `control`
- `shift`
- `alt` / `option`

Examples:

- `mod+j`
- `mod+shift+d`
- `ctrl+l`
- `cmd+k`

### `when` Conditions

Currently available context keys:

- `terminalFocus`
- `terminalOpen`

Supported operators:

- `!` (not)
- `&&` (and)
- `||` (or)
- parentheses: `(` `)`

Examples:

- `"when": "terminalFocus"`
- `"when": "terminalOpen && !terminalFocus"`
- `"when": "terminalFocus || terminalOpen"`

Unknown condition keys evaluate to `false`.

### Precedence

- Rules are evaluated in array order.
- For a key event, the last rule where both `key` matches and `when` evaluates to `true` wins.
- That means precedence is across commands, not only within the same command.
