const GROUND = 0;
const ESCAPE = 1;
const ESCAPE_INTERMEDIATE = 2;
const CSI = 3;
const CONTROL_STRING = 4;
const OSC = 5;
const STRING_ESCAPE = 6;
const encoder = new TextEncoder();

// The low three bits hold the parser mode. Higher bits hold a split surrogate.
function nextState(
  state: number,
  unit: number,
  onC1?: (byte: number, remainingBytes: number) => void,
): number {
  let mode = state & 7;
  if (unit === 0x1b) {
    return mode === CONTROL_STRING || mode === OSC ? STRING_ESCAPE : ESCAPE;
  }
  if (unit === 0x18 || unit === 0x1a || unit === 0x9c || (unit === 7 && mode === OSC)) {
    return GROUND;
  }
  if (mode === STRING_ESCAPE) {
    if (unit === 0x5c) return GROUND;
    mode = ESCAPE;
  }
  if (unit < 0x80) {
    switch (mode) {
      case ESCAPE:
        if (unit < 0x20 || unit === 0x7f) return mode;
        if (unit < 0x30) return ESCAPE_INTERMEDIATE;
        if (unit === 0x5b) return CSI;
        if (unit === 0x5d) return OSC;
        return unit === 0x50 || unit === 0x58 || unit === 0x5e || unit === 0x5f
          ? CONTROL_STRING
          : GROUND;
      case ESCAPE_INTERMEDIATE:
        return unit >= 0x30 && unit !== 0x7f ? GROUND : mode;
      case CSI:
        return unit >= 0x40 && unit !== 0x7f ? GROUND : mode;
      default:
        return mode;
    }
  }

  if (mode === OSC) return mode;
  if (mode === GROUND && unit > 0x9f) return mode;
  if (unit >= 0xd800 && unit <= 0xdbff) return mode | (unit << 3);
  let codePoint = unit;
  if (unit >= 0xdc00 && unit <= 0xdfff) {
    if (state < 8) return mode;
    codePoint = 0x10000 + (((state >> 3) - 0xd800) << 10) + unit - 0xdc00;
  }
  // In a discarded non-OSC sequence a UTF-8 continuation byte can act as C1.
  for (let shift = codePoint > 0xffff ? 12 : codePoint > 0x7ff ? 6 : 0; shift >= 0; shift -= 6) {
    const byte = 0x80 | ((codePoint >> shift) & 0x3f);
    if (byte >= 0xa0) continue;
    if (byte === 0x9d) return OSC;
    if (byte === 0x9b) mode = CSI;
    else if (byte === 0x90 || byte === 0x98 || byte >= 0x9e) mode = CONTROL_STRING;
    else {
      onC1?.(byte, shift / 6);
      return GROUND;
    }
  }
  return mode;
}

/** Advance across evicted history, skipping printable runs in ground state. */
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

/** Skip omitted control payload and preserve C1 layout controls on the return to ground. */
export function replayTerminalContinuation(state: number, data: string, maxBytes?: number) {
  if (state === GROUND || !data) return { state, data };
  let control = "";
  let replacements = 0;
  const onC1 = (byte: number, remainingBytes: number) => {
    if (byte === 0x84 || byte === 0x85 || byte === 0x88 || byte === 0x8d) {
      control = "\x1b" + String.fromCharCode(byte - 0x40);
    }
    replacements = remainingBytes;
  };
  let end = 0;
  while (state !== GROUND && end < data.length) {
    const unit = data.charCodeAt(end);
    if (state === STRING_ESCAPE && unit !== 0x5c) {
      // The held ESC starts a new sequence. Within bounded history, only restore
      // it when the preceding discarded payload freed a byte.
      if (maxBytes === undefined || end > 0 || encoder.encode(data).byteLength < maxBytes) {
        return { state: GROUND, data: "\x1b" + data.slice(end) };
      }
    }
    state = unit === 0x1b ? STRING_ESCAPE : nextState(state, unit, onC1);
    end++;
  }
  const tail = data.slice(end);
  if (maxBytes !== undefined && replacements > 0) {
    const available = maxBytes - encoder.encode(tail).byteLength - control.length;
    replacements = Math.min(replacements, Math.max(0, Math.floor(available / 3)));
  }
  return { state, data: control + "\ufffd".repeat(replacements) + tail };
}
