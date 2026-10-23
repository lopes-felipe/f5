# Keybindings

See every keyboard shortcut in F5 and change any of them. Press `mod+/` for a quick reference
anywhere in the app.

![Settings → Keyboard listing shortcuts with search](docs/images/settings-keyboard.webp)

## How to

1. Open **Settings → Keyboard**.
2. Use **Search keybindings** to find a shortcut by command, key or context.
3. Edit a binding there, or edit `~/.f5/userdata/keybindings.json` (`keybindings.json` in the
   state directory) directly.

`mod` means `cmd` on macOS and `ctrl` elsewhere.

## Good to know

- `mod+b` toggles the sidebar, except while a terminal or dialog has focus.
- `mod+shift+n` opens a new workflow.
- `mod+enter` scrolls to the bottom of the chat; it doesn't send. In a dialog it runs the primary
  action.
- `chat.newLocal` has no default binding but can still be bound.
- Invalid rules, and invalid files, are ignored and logged by the server.

## The keybindings file

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
  { "key": "mod+[", "command": "navigation.back", "when": "!terminalFocus && !dialogFocus" },
  { "key": "mod+]", "command": "navigation.forward", "when": "!terminalFocus && !dialogFocus" },
  {
    "key": "mod+z",
    "command": "thread.undo",
    "when": "threadUndoAvailable && !editableFocus && !dialogFocus"
  },
  {
    "key": "pageup",
    "command": "chat.pageUp",
    "when": "!composerFocus && !terminalFocus && !dialogFocus"
  },
  {
    "key": "pagedown",
    "command": "chat.pageDown",
    "when": "!composerFocus && !terminalFocus && !dialogFocus"
  },
  {
    "key": "mod+w",
    "command": "rightPanel.closeTab",
    "when": "isElectron && !terminalFocus && !dialogFocus"
  },
  {
    "key": "mod+shift+e",
    "command": "composer.effort",
    "when": "isElectron && !terminalFocus && !dialogFocus"
  },
  {
    "key": "mod+shift+a",
    "command": "composer.runtimeMode",
    "when": "isElectron && !terminalFocus && !dialogFocus"
  },
  {
    "key": "mod+shift+x",
    "command": "composer.envMode",
    "when": "isElectron && !terminalFocus && !dialogFocus"
  },
  {
    "key": "mod+shift+g",
    "command": "composer.branch",
    "when": "isElectron && !terminalFocus && !dialogFocus"
  },
  {
    "key": "mod+shift+u",
    "command": "composer.interactionMode",
    "when": "isElectron && !terminalFocus && !dialogFocus"
  },
  {
    "key": "mod+shift+arrowup",
    "command": "modelPicker.previousProvider",
    "when": "modelPickerOpen"
  },
  {
    "key": "mod+shift+arrowdown",
    "command": "modelPicker.nextProvider",
    "when": "modelPickerOpen"
  },
  {
    "key": "mod+shift+k",
    "command": "prHub.copyNumber",
    "when": "isElectron && !terminalFocus && !dialogFocus"
  },
  { "key": "mod+b", "command": "sidebar.toggle", "when": "!terminalFocus && !dialogFocus" },
  { "key": "mod+j", "command": "terminal.toggle" },
  { "key": "mod+d", "command": "terminal.split", "when": "terminalFocus" },
  { "key": "mod+n", "command": "terminal.new", "when": "terminalFocus" },
  { "key": "mod+w", "command": "terminal.close", "when": "terminalFocus" },
  { "key": "mod+d", "command": "diff.toggle", "when": "!terminalFocus" },
  { "key": "mod+n", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+shift+n", "command": "workflow.new", "when": "!terminalFocus" },
  { "key": "mod+enter", "command": "chat.scrollToBottom", "when": "!dialogFocus" },
  { "key": "mod+shift+enter", "command": "chat.queueTurn", "when": "!dialogFocus" },
  {
    "key": "mod+alt+enter",
    "command": "chat.sendAndNew",
    "when": "composerFocus && !newThreadComposer && !terminalFocus && !dialogFocus"
  },
  { "key": "alt+enter", "command": "chat.queueTurnNext", "when": "!dialogFocus" },
  {
    "key": "mod+shift+v",
    "command": "composer.pasteAsText",
    "when": "isElectron && composerFocus && !dialogFocus"
  },
  { "key": "mod+s", "command": "composer.stash", "when": "composerFocus && !dialogFocus" },
  { "key": "mod+enter", "command": "dialog.primaryAction", "when": "dialogFocus" },
  { "key": "mod+o", "command": "editor.openFavorite" },
  { "key": "ctrl+tab", "command": "thread.switchRecentNext" },
  { "key": "ctrl+shift+tab", "command": "thread.switchRecentPrevious" },
  { "key": "alt+tab", "command": "model.switchRecent" },
  { "key": "mod+shift+p", "command": "prHub.open", "when": "!terminalFocus" },
  { "key": "mod+p", "command": "palette.files", "when": "!terminalFocus" },
  { "key": "mod+shift+f", "command": "projectContentSearch.toggle", "when": "!terminalFocus" },
  { "key": "mod+shift+m", "command": "modelPicker.toggle", "when": "!terminalFocus" },
  { "key": "mod+1", "command": "modelPicker.jump.1", "when": "modelPickerOpen" },
  { "key": "mod+2", "command": "modelPicker.jump.2", "when": "modelPickerOpen" },
  { "key": "mod+3", "command": "modelPicker.jump.3", "when": "modelPickerOpen" },
  { "key": "mod+4", "command": "modelPicker.jump.4", "when": "modelPickerOpen" },
  { "key": "mod+5", "command": "modelPicker.jump.5", "when": "modelPickerOpen" },
  { "key": "mod+6", "command": "modelPicker.jump.6", "when": "modelPickerOpen" },
  { "key": "mod+7", "command": "modelPicker.jump.7", "when": "modelPickerOpen" },
  { "key": "mod+8", "command": "modelPicker.jump.8", "when": "modelPickerOpen" },
  { "key": "mod+9", "command": "modelPicker.jump.9", "when": "modelPickerOpen" },
  { "key": "mod+k", "command": "commandPalette.toggle", "when": "!terminalFocus" },
  { "key": "mod+/", "command": "help.shortcuts", "when": "!terminalFocus" },
  {
    "key": "mod+enter",
    "command": "chat.newBackground",
    "when": "newThreadComposer && !dialogFocus"
  },
  {
    "key": "j",
    "command": "upstream.next",
    "when": "upstreamListFocus && !editableFocus && !dialogFocus"
  },
  {
    "key": "k",
    "command": "upstream.previous",
    "when": "upstreamListFocus && !editableFocus && !dialogFocus"
  },
  {
    "key": "x",
    "command": "upstream.toggleSelect",
    "when": "upstreamListFocus && !editableFocus && !dialogFocus"
  },
  {
    "key": "shift+a",
    "command": "upstream.selectAll",
    "when": "upstreamListFocus && !editableFocus && !dialogFocus"
  },
  {
    "key": "a",
    "command": "upstream.acceptSuggestion",
    "when": "upstreamListFocus && !editableFocus && !dialogFocus"
  },
  {
    "key": "p",
    "command": "upstream.port",
    "when": "upstreamListFocus && !editableFocus && !dialogFocus"
  },
  {
    "key": "s",
    "command": "upstream.skip",
    "when": "upstreamListFocus && !editableFocus && !dialogFocus"
  },
  {
    "key": "w",
    "command": "upstream.watch",
    "when": "upstreamListFocus && !editableFocus && !dialogFocus"
  },
  {
    "key": "d",
    "command": "upstream.decline",
    "when": "upstreamListFocus && !editableFocus && !dialogFocus"
  },
  {
    "key": "u",
    "command": "upstream.reopen",
    "when": "upstreamListFocus && !editableFocus && !dialogFocus"
  },
  {
    "key": "enter",
    "command": "upstream.openDetail",
    "when": "upstreamListFocus && !editableFocus && !dialogFocus"
  },
  {
    "key": "o",
    "command": "upstream.openUpstreamPr",
    "when": "upstreamListFocus && !editableFocus && !dialogFocus"
  },
  {
    "key": "shift+p",
    "command": "upstream.startPort",
    "when": "upstreamListFocus && !editableFocus && !dialogFocus"
  }
]
```

For the most up to date defaults, see [`DEFAULT_KEYBINDINGS` in `packages/shared/src/keybindings.ts`](packages/shared/src/keybindings.ts), which the server re-exports from `apps/server/src/keybindings.ts`.

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
- `chat.queueTurn`: queue the composer contents at the end (`Mod+Shift+Enter` by default)
- `chat.queueTurnNext`: queue the composer contents next (`Alt+Enter` by default)
- `composer.stash`: save and clear the current composer draft (`Mod+S` while the composer is focused by default)
- `editor.openFavorite`: open current project/worktree in the last-used editor
- `thread.switchRecentNext`: cycle to the next recent tab/page (`Ctrl+Tab` by default). This now includes thread tabs, workflow pages, and settings.
- `thread.switchRecentPrevious`: cycle to the previous recent tab/page (`Ctrl+Shift+Tab` by default)
- `model.switchRecent`: cycle to the next recent model (`Alt+Tab` by default)
- `commandPalette.toggle`: open or close the command palette
- `help.shortcuts`: open or close the keyboard shortcuts reference (`Mod+/` by default)
- `palette.files`: open the command palette in project-file mode
- `projectContentSearch.toggle`: open the command palette in project-content mode
- `script.{id}.run`: run a project script by id (for example `script.test.run`)
- `upstream.*`: Upstream page list commands; see [Upstream page](#upstream-page)

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
- `composerFocus`
- `dialogFocus`
- `editableFocus` (an input, textarea or editable element has focus)
- `upstreamListFocus` (the Upstream page topic list has focus)

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

## Upstream page

These single-key shortcuts work while the Upstream topic list has focus and no text field or
dialog does. Decisions apply to the selected topics, or to the focused topic when none are
selected, and focus moves to the next row.

| Key       | Command                     | Action                                                     |
| --------- | --------------------------- | ---------------------------------------------------------- |
| `j`       | `upstream.next`             | Next topic                                                 |
| `k`       | `upstream.previous`         | Previous topic                                             |
| `x`       | `upstream.toggleSelect`     | Select or unselect the focused topic                       |
| `Shift+a` | `upstream.selectAll`        | Select or clear all loaded topics                          |
| `a`       | `upstream.acceptSuggestion` | Accept each selected topic's triage suggestion             |
| `p`       | `upstream.port`             | Mark for porting                                           |
| `s`       | `upstream.skip`             | Skip, with the reason menu preselected from the suggestion |
| `w`       | `upstream.watch`            | Watch for 30 days                                          |
| `d`       | `upstream.decline`          | Decline with a reason                                      |
| `u`       | `upstream.reopen`           | Move back to Inbox                                         |
| `Enter`   | `upstream.openDetail`       | Move focus to the detail pane                              |
| `o`       | `upstream.openUpstreamPr`   | Open the first upstream PR                                 |
| `Shift+p` | `upstream.startPort`        | Open Start port for Ready topics                           |
