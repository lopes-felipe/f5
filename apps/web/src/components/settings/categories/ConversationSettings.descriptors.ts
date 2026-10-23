import { SETTINGS_ITEM_ROUTES } from "../settingsRouting";
import type { SettingsItemDescriptor } from "../settingsSearch";

const CONVERSATION_CONTROL_DESCRIPTORS = (
  [
    [
      "send-shortcut",
      "Send shortcut",
      "Send with Enter or Command/Ctrl+Enter, including multiline prompts.",
      "Send shortcut",
      ["composer", "keyboard", "multiline"],
    ],
    [
      "composer-editor",
      "Rich text editor",
      "Choose styled Markdown or plain text in the composer.",
      "Rich text editor",
      ["composer", "markdown", "plain text"],
    ],
    [
      "composer-collapse",
      "Collapse composer while scrolling",
      "Keep the composer expanded or let timeline scrolling collapse it.",
      "Collapse composer while scrolling",
      ["composer", "scroll", "resting", "collapse"],
    ],
    [
      "compact-layout",
      "Compact chat layout",
      "Show tasks, queued turns and notices as chips above the composer.",
      "Compact chat layout",
      ["composer", "horizontal", "chips", "tray", "density", "space"],
    ],
    [
      "streaming",
      "Stream assistant messages",
      "Show output while a response is in progress.",
      "Stream assistant messages",
      ["tokens", "response"],
    ],
    [
      "remote-images",
      "Load remote images in chat",
      "Allow HTTPS images from external websites, and HTTPS images and scripts in HTML pages agents show. Even when off, an HTML page opened in a web browser rather than the desktop app can still navigate away, taking what it shows with it.",
      "Load remote images in chat",
      ["images", "privacy", "markdown", "html", "scripts"],
    ],
    [
      "word-wrap",
      "Wrap long code and table lines",
      "Wrap chat code, tables, diffs, and previews.",
      "Wrap long code and table lines",
      ["diff", "code", "table", "line wrap"],
    ],
    [
      "diff-default",
      "Default diff file state",
      "Expand, collapse, or automatically size diff files.",
      "Default diff file state",
      ["diff", "expanded", "collapsed"],
    ],
    [
      "work-log-detail",
      "Work log detail level",
      "Choose essential, standard, or diagnostic work-log detail.",
      "Work log detail level",
      ["activity", "diagnostics", "tools"],
    ],
    [
      "work-log-category",
      "Work log category",
      "Show all work or filter the work log to one category.",
      "Work log category",
      ["activity", "filter", "tools"],
    ],
    [
      "workflow-expand",
      "Auto-expand workflows in sidebar",
      "Show workflow subthreads without opening them first.",
      "Auto-expand workflows in sidebar",
      ["workflow", "sidebar", "threads"],
    ],
    [
      "command-output",
      "Show command output in thread",
      "Display agent commands and output inline.",
      "Show command output in thread",
      ["terminal", "transcript", "shell"],
    ],
    [
      "command-expand",
      "Auto-expand command output",
      "Open command output automatically.",
      "Auto-expand command output",
      ["terminal", "transcript", "shell"],
    ],
    [
      "mcp-details",
      "Show MCP tool call details",
      "Display MCP inputs and results in expandable cards.",
      "Show MCP tool call details",
      ["tools", "server", "model context protocol"],
    ],
    [
      "mcp-expand",
      "Auto-expand MCP cards",
      "Open MCP cards automatically.",
      "Auto-expand MCP cards",
      ["tools", "server", "model context protocol"],
    ],
    [
      "reasoning",
      "Auto-expand reasoning",
      "Show model thinking inline instead of collapsed.",
      "Auto-expand reasoning",
      ["thinking", "analysis"],
    ],
    [
      "collapse-work-logs",
      "Collapse finished work logs",
      "Fold a finished turn's tool calls into a one-line summary.",
      "Collapse finished work logs",
      ["activity", "tools", "summary"],
    ],
    [
      "inline-diffs",
      "Show file diffs inline",
      "Display complete diffs for file changes in chat.",
      "Show file diffs inline",
      ["changes", "patch", "code"],
    ],
    [
      "runtime-warnings",
      "Runtime warnings",
      "Choose how much provider warning detail is shown.",
      "Runtime warnings",
      ["provider", "errors", "diagnostics"],
    ],
    [
      "provider-metadata",
      "Show provider metadata",
      "Display the active model, CLI version, and session details.",
      "Show provider metadata",
      ["model", "session", "version"],
    ],
  ] as const
).map(
  ([id, label, description, ariaLabel, keywords]): SettingsItemDescriptor => ({
    ...SETTINGS_ITEM_ROUTES[`conversation.${id}`],
    label,
    description,
    keywords,
    targetSelector: `[aria-label="${ariaLabel}"]`,
  }),
);

export const CONVERSATION_SETTINGS_DESCRIPTORS = [
  ...CONVERSATION_CONTROL_DESCRIPTORS,
  {
    ...SETTINGS_ITEM_ROUTES["conversation.display-density"],
    label: "Display density",
    description: "Pick a minimal, balanced, or detailed preset for thread activity.",
    keywords: ["preset", "verbosity", "detail", "minimal", "detailed"],
    targetSelector: '[data-settings-search-target="conversation.display-density"]',
  },
] satisfies ReadonlyArray<SettingsItemDescriptor>;
