const GROUND = 0;
const ESCAPE = 1;
const ESCAPE_INTERMEDIATE = 2;
const CSI_ENTRY = 3;
const DCS_PAYLOAD = 4;
const OSC = 5;
const STRING_ESCAPE = 6;
const APC = 7; // Also SOS and PM.
const DCS_ENTRY = 8;
const DCS_PARAM = 9;
const DCS_INTERMEDIATE = 10;
const DCS_IGNORE = 11;
const CSI_PARAM = 12;
const CSI_INTERMEDIATE = 13;
const CSI_IGNORE = 14;
const SPLIT_SURROGATE = 16;

// Track xterm's transitions that determine where omitted output ends. JavaScript
// strings reach xterm as code points, so only actual C1 characters are controls.
function nextState(state: number, code: number): number {
  if (code === 0xfeff) return state; // xterm's string decoder skips BOMs.
  if (code === 0x1b) {
    return state === DCS_PAYLOAD || state === OSC || state === APC ? STRING_ESCAPE : ESCAPE;
  }
  if (code === 0x18 || code === 0x1a) return GROUND;
  if (code >= 0x80 && code <= 0x9f) {
    if (code === 0x90) return DCS_ENTRY;
    if (code === 0x9b) return CSI_ENTRY;
    if (code === 0x9d) return OSC;
    if (code === 0x98 || code >= 0x9e) return APC;
    return GROUND;
  }
  if (state === STRING_ESCAPE) state = ESCAPE;
  if (state === OSC) return code === 7 ? GROUND : OSC;
  if (state === DCS_PAYLOAD || state === DCS_IGNORE || state === CSI_IGNORE) {
    return state === CSI_IGNORE && code >= 0x40 && code < 0x7f ? GROUND : state;
  }
  if (code >= 0xa0) return GROUND;
  if (code < 0x20 || code === 0x7f) return state;
  switch (state) {
    case APC:
      return APC;
    case ESCAPE:
      if (code < 0x30) return ESCAPE_INTERMEDIATE;
      if (code === 0x5b) return CSI_ENTRY;
      if (code === 0x5d) return OSC;
      if (code === 0x50) return DCS_ENTRY;
      return code === 0x58 || code === 0x5e || code === 0x5f ? APC : GROUND;
    case ESCAPE_INTERMEDIATE:
      return code < 0x30 ? state : GROUND;
    case CSI_ENTRY:
    case CSI_PARAM:
    case CSI_INTERMEDIATE:
      if (code >= 0x40) return GROUND;
      if (code < 0x30) return CSI_INTERMEDIATE;
      return state === CSI_INTERMEDIATE || (state === CSI_PARAM && code >= 0x3c)
        ? CSI_IGNORE
        : CSI_PARAM;
    case DCS_ENTRY:
    case DCS_PARAM:
    case DCS_INTERMEDIATE:
      if (code >= 0x40) return DCS_PAYLOAD;
      if (code < 0x30) return DCS_INTERMEDIATE;
      return state === DCS_INTERMEDIATE || (state === DCS_PARAM && code >= 0x3c)
        ? DCS_IGNORE
        : DCS_PARAM;
    default:
      return GROUND;
  }
}

/** Advance across evicted history, which is already aligned to code points. */
export function terminalSequenceStateAfter(
  state: number,
  text: string,
  start: number,
  end: number,
): number {
  // eslint-disable-next-line no-control-regex -- Recognize ESC and the C1 sequence introducers.
  const introducer = /[\x1b\x90\x98\x9b\x9d-\x9f]/g;
  const prefix = start === 0 && end === text.length ? text : text.slice(start, end);
  for (let index = 0; index < prefix.length; index++) {
    if (state === GROUND) {
      introducer.lastIndex = index;
      const match = introducer.exec(prefix);
      if (!match) break;
      index = match.index;
    }
    state = nextState(state, prefix.charCodeAt(index));
  }
  return state;
}

/** Skip omitted payload, retaining layout controls that xterm executes. */
export function replayTerminalContinuation(state: number, data: string, spareBytes = Infinity) {
  if (state === GROUND || !data) return { state, data };
  let end = 0;
  if (state & SPLIT_SURROGATE) {
    state &= ~SPLIT_SURROGATE;
    const first = data.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) end++;
    state = nextState(state, 0xa0);
  }
  let control = "";
  while (state !== GROUND && end < data.length) {
    const code = data.codePointAt(end)!;
    if (state === STRING_ESCAPE && code !== 0x5c && (end > 0 || spareBytes > 0)) {
      return { state: GROUND, data: "\x1b" + data.slice(end) };
    }
    if (code >= 0xd800 && code <= 0xdbff && end === data.length - 1) {
      return { state: state | SPLIT_SURROGATE, data: "" };
    }
    state = code === 0x1b ? STRING_ESCAPE : nextState(state, code);
    if (code === 0x84 || code === 0x85 || code === 0x88) {
      control = "\x1b" + String.fromCharCode(code - 0x40);
    }
    end += code > 0xffff ? 2 : 1;
  }
  return { state, data: control + data.slice(end) };
}
