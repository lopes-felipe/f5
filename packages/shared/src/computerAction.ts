export const COMPUTER_ACTION_VERB: Record<string, readonly [ongoing: string, done: string]> = {
  wait: ["Waiting", "Waited"],
  requestForeground: ["Requesting foreground", "Requested foreground"],
  screenshot: ["Taking a screenshot", "Took a screenshot"],
  zoom: ["Zooming in", "Zoomed in"],
  inspect: ["Reading the screen", "Read the screen"],
  click: ["Clicking", "Clicked"],
  move: ["Moving the pointer", "Moved the pointer"],
  drag: ["Dragging", "Dragged"],
  scroll: ["Scrolling", "Scrolled"],
  type: ["Typing", "Typed"],
  key: ["Pressing a key", "Pressed a key"],
  elementAction: ["Using a control", "Used a control"],
  openApp: ["Opening app", "Opened app"],
  activateApp: ["Switching app", "Switched app"],
  listApps: ["Listing apps", "Listed apps"],
  resolveApps: ["Finding apps", "Found apps"],
  status: ["Checking status", "Checked status"],
  requestAccess: ["Requesting access", "Requested access"],
};

const TOOL_OPS: Record<string, string> = {
  list_apps: "listApps",
  request_access: "requestAccess",
  request_foreground: "requestForeground",
  element_action: "elementAction",
  open_app: "openApp",
  activate_app: "activateApp",
};
/** The computer op for a `computer_*` tool name, with or without its `mcp__server__` prefix. */
export function computerToolOp(toolName: string | undefined): string | undefined {
  const name = toolName?.split("__").at(-1);
  if (!name?.startsWith("computer_")) return undefined;
  const suffix = name.slice("computer_".length);
  const op = TOOL_OPS[suffix] ?? suffix;
  return COMPUTER_ACTION_VERB[op] ? op : undefined;
}

function actionHeading(
  words: readonly [ongoing: string, done: string],
  status: string | undefined,
): string {
  return status === "inProgress" || status === "running" || status === "started"
    ? `${words[0]}…`
    : status === "failed" || status === "error"
      ? `${words[0]} failed`
      : words[1];
}

/** Identity/provenance is checked by ingestion; this function only chooses wording. */
export function computerToolHeading(
  toolName: string | undefined,
  status: string | undefined,
): string | undefined {
  const op = computerToolOp(toolName);
  return op ? actionHeading(COMPUTER_ACTION_VERB[op]!, status) : undefined;
}

export const PREVIEW_ACTION_VERB: Record<string, readonly [ongoing: string, done: string]> = {
  status: ["Checking the preview", "Checked the preview"],
  open: ["Opening the preview", "Opened the preview"],
  navigate: ["Navigating", "Navigated"],
  snapshot: ["Reading the page", "Read the page"],
  click: ["Clicking", "Clicked"],
  type: ["Typing", "Typed"],
  press: ["Pressing a key", "Pressed a key"],
  scroll: ["Scrolling", "Scrolled"],
  evaluate: ["Running a script", "Ran a script"],
  wait_for: ["Waiting", "Waited"],
  viewport: ["Resizing the viewport", "Resized the viewport"],
  screenshot: ["Taking a screenshot", "Took a screenshot"],
  recording_start: ["Starting a recording", "Started a recording"],
  recording_stop: ["Stopping the recording", "Stopped the recording"],
};

// Claude names it f5_preview (suffixed on collision), ACP f5_preview_<hex>, Codex __f5_preview.
const PREVIEW_SERVER_NAME = /^_*f5_preview(?:_[0-9a-z]+)?$/;

/**
 * The preview op for an F5 browser preview tool. Matched by name only: preview payloads are
 * not sanitized, so a lookalike server can change how a call is drawn but exposes nothing.
 */
export function previewToolOp(
  serverName: string | undefined,
  toolName: string | undefined,
): string | undefined {
  const parts = toolName?.split("__") ?? [];
  const server = serverName ?? (parts.length >= 3 ? parts.slice(1, -1).join("__") : undefined);
  if (!server || !PREVIEW_SERVER_NAME.test(server)) return undefined;
  const name = parts.at(-1);
  if (!name?.startsWith("preview_")) return undefined;
  const op = name.slice("preview_".length);
  return PREVIEW_ACTION_VERB[op] ? op : undefined;
}

export function previewToolHeading(
  toolName: string | undefined,
  status: string | undefined,
): string | undefined {
  const name = toolName?.split("__").at(-1);
  const words = name?.startsWith("preview_")
    ? PREVIEW_ACTION_VERB[name.slice("preview_".length)]
    : undefined;
  return words ? actionHeading(words, status) : undefined;
}

/** Bounded, display-only facts about one computer action. Never carries typed text. */
export interface ComputerStepSummary {
  readonly appName?: string;
  readonly x?: number;
  readonly y?: number;
  readonly keyChord?: string;
  readonly repeat?: number;
  readonly typedLength?: number;
  readonly outcome?: string;
}

const NAMED_KEYS = new Set(
  [
    "Meta",
    "Cmd",
    "Command",
    "Control",
    "Ctrl",
    "Alt",
    "Option",
    "Shift",
    "Fn",
    "Enter",
    "Return",
    "Tab",
    "Escape",
    "Esc",
    "Space",
    "Backspace",
    "Delete",
    "Up",
    "Down",
    "Left",
    "Right",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Minus",
    "Equal",
    "Plus",
    "Comma",
    "Period",
    "Slash",
    "Backslash",
    "Semicolon",
    "Quote",
    "Backquote",
    "BracketLeft",
    "BracketRight",
    ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  ].map((key) => key.toLowerCase()),
);

function isKeyToken(token: string): boolean {
  return [...token].length === 1 ? token.trim().length === 1 : NAMED_KEYS.has(token.toLowerCase());
}

/** Each chord is `+`-joined key names; anything else could be free text, so it is dropped. */
function keyChordFromKeys(keys: unknown): string | undefined {
  const chords = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : [];
  if (chords.length === 0 || chords.length > 16) return undefined;
  const valid = chords.every(
    (chord) =>
      typeof chord === "string" &&
      chord.length <= 64 &&
      // "Meta++" names the plus key; split keeps it as an empty trailing token.
      chord
        .replace(/\+\+$/, "+Plus")
        .split("+")
        .every((token) => isKeyToken(token)),
  );
  if (!valid) return undefined;
  const joined = (chords as string[]).join(", ");
  return joined.length <= 64 ? joined : undefined;
}

const OUTCOME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
const isCoordinate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;

/** Re-validates a summary that crossed a process or storage boundary. */
export function sanitizeComputerStep(value: unknown): ComputerStepSummary | undefined {
  if (!isRecord(value)) return undefined;
  const step: {
    -readonly [K in keyof ComputerStepSummary]: ComputerStepSummary[K];
  } = {};
  if (typeof value.appName === "string") {
    const appName = value.appName.trim();
    if (appName && appName.length <= 200) step.appName = appName;
  }
  if (isCoordinate(value.x) && isCoordinate(value.y)) {
    step.x = Math.round(value.x);
    step.y = Math.round(value.y);
  }
  if (typeof value.keyChord === "string") {
    const keyChord = keyChordFromKeys(value.keyChord.split(", "));
    if (keyChord) step.keyChord = keyChord;
  }
  if (isCount(value.repeat, 20) && value.repeat > 1) step.repeat = value.repeat;
  if (isCount(value.typedLength, 10_000)) step.typedLength = value.typedLength;
  if (typeof value.outcome === "string" && OUTCOME.test(value.outcome))
    step.outcome = value.outcome;
  return Object.keys(step).length ? step : undefined;
}

function parseJsonRecord(text: unknown): Record<string, unknown> | undefined {
  if (typeof text !== "string" || !text.trimStart().startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function resultContent(result: unknown): {
  structured: Record<string, unknown> | undefined;
  isError: boolean;
} {
  const record = isRecord(result) ? result : undefined;
  const blocks = Array.isArray(result)
    ? result
    : Array.isArray(record?.content)
      ? record.content
      : [];
  const firstText = blocks.find(
    (block): block is Record<string, unknown> => isRecord(block) && block.type === "text",
  );
  const structured = isRecord(record?.structuredContent)
    ? record.structuredContent
    : parseJsonRecord(firstText?.text);
  const isError =
    record?.isError === true || record?.is_error === true || isRecord(structured?.error);
  return { structured, isError };
}

/** Builds the summary from a raw (unsanitized) tool event `data` envelope. */
export function extractComputerStep(
  toolName: string | undefined,
  data: unknown,
): ComputerStepSummary | undefined {
  const op = computerToolOp(toolName);
  if (!op || !isRecord(data)) return undefined;
  const item = isRecord(data.item) ? data.item : undefined;
  const input = [data.input, data.arguments, item?.input, item?.arguments].find(isRecord);
  const rawResult = data.result ?? item?.result;
  const { structured, isError } = resultContent(rawResult);
  const error = isRecord(structured?.error) ? structured.error : undefined;
  const textLength = typeof input?.text === "string" ? [...input.text].length : undefined;
  return sanitizeComputerStep({
    appName: structured?.appName,
    ...(op === "click" || op === "move" || op === "scroll" ? { x: input?.x, y: input?.y } : {}),
    ...(op === "key" && rawResult !== undefined && !isError
      ? { keyChord: keyChordFromKeys(input?.keys), repeat: input?.repeat }
      : {}),
    ...(op === "type" ? { typedLength: textLength } : {}),
    outcome: isError ? error?._tag : structured?.outcome,
  });
}
