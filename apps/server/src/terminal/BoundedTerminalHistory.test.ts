import { describe, expect, it } from "vitest";
import { BoundedTerminalHistory, TERMINAL_HISTORY_MAX_BYTES } from "./BoundedTerminalHistory";

function reference(text: string, maxLines: number, maxBytes: number): string {
  if (!maxLines || !maxBytes) return "";
  const trailing = text.endsWith("\n");
  const lines = Buffer.from(text).toString("utf8").split("\n");
  if (trailing) lines.pop();
  let result = lines.slice(-maxLines).join("\n") + (trailing ? "\n" : "");
  while (Buffer.byteLength(result) > maxBytes) {
    const newline = result.indexOf("\n");
    result =
      newline >= 0 && newline < result.length - 1
        ? result.slice(newline + 1)
        : result.slice(result.codePointAt(0)! > 0xffff ? 2 : 1);
  }
  return result;
}

describe("BoundedTerminalHistory", () => {
  it("strips capability traffic at every chunk boundary while preserving visual controls", () => {
    const queries = [
      "\x1b[?2026$p",
      "\x1b[?2026;2$y",
      "\x1b[>q",
      "\x1b[?u",
      "\x1b[?31u",
      "\x1bP$q m\x1b\\",
      "\x1bP1$r0m\x1b\\",
      "\x1bP+q544e\x1b\\",
      "\x1bP1+r544e=1b\x1b\\",
      "\x90$q m\x9c",
      "\x901$r0m\x9c",
      "\x90+q544e\x9c",
      "\x901+r544e=1b\x9c",
      "\x9b?31u",
      "\x9b?2026$p",
      "\x1b[6n",
      "\x1b[1;2R",
      "\x1b[>0c",
      "\x1b]11;?\x07",
      "\x1b]11;rgb:ffff/ffff/ffff\x1b\\",
    ].join("");
    const visual =
      '\x1b[!p\x1b["p\x1b[4 q\x1b[u\x1b[31mred\x1b[0m\x1b[2J' +
      "\x1b[>1u\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\" +
      "\x1bPvisual data\x1b\\";
    const input = "before " + queries + visual + "after\n";
    for (let split = 0; split <= input.length; split++) {
      const history = new BoundedTerminalHistory();
      history.append(input.slice(0, split));
      history.append(input.slice(split));
      expect(history.value()).toBe("before " + visual + "after\n");
    }
    const history = new BoundedTerminalHistory();
    for (const ch of input) history.append(ch);
    expect(history.value()).toBe("before " + visual + "after\n");
  });

  it("discards unfinished controls on stream end and clear without joining new output", () => {
    const history = new BoundedTerminalHistory();
    history.append("before\x1bP$q");
    history.finish();
    history.append("after");
    expect(history.value()).toBe("beforeafter");
    history.append("\x1b[?");
    history.clear();
    history.append("new");
    expect(history.value()).toBe("new");
  });

  it("bounds malformed CSI state and handles long string controls across chunks", () => {
    const history = new BoundedTerminalHistory();
    history.append("before\x1b[?" + "1;".repeat(10_000));
    history.append("pafter");
    history.append("\x1bP+q" + "544e".repeat(10_000));
    history.append("\x1b");
    history.append("\\end");
    expect(history.value()).toBe("beforeafterend");
    const visual = "\x1b]8;;https://example.com/" + "path/".repeat(20);
    history.append(visual);
    history.append("\x1b");
    history.append("\\link");
    expect(history.value()).toBe("beforeafterend" + visual + "\x1b\\link");
  });

  it("keeps the last 5000 lines, including empty lines and trailing newlines", () => {
    const history = new BoundedTerminalHistory();
    history.append(Array.from({ length: 6000 }, (_, i) => `${i}\n`).join(""));
    expect(history.value()).toBe(Array.from({ length: 5000 }, (_, i) => `${i + 1000}\n`).join(""));
    const small = new BoundedTerminalHistory(2);
    small.append("first\n\nlast");
    expect(small.value()).toBe("\nlast");
    small.append("\n");
    expect(small.value()).toBe("\nlast\n");
  });

  it("evicts whole old lines before truncating an oversized last line", () => {
    const history = new BoundedTerminalHistory(5000, 10);
    history.append("old line\nnew");
    expect(history.value()).toBe("new");
    history.append("🙂".repeat(5));
    expect(history.value()).toBe("🙂🙂");
    expect(history.byteLength).toBe(8);
  });

  it("bounds huge lines on code-point boundaries without losing subsequent output", () => {
    const history = new BoundedTerminalHistory();
    history.append("🙂".repeat(TERMINAL_HISTORY_MAX_BYTES / 4 + 100));
    expect(history.byteLength).toBe(TERMINAL_HISTORY_MAX_BYTES);
    expect(history.value()).toBe("🙂".repeat(TERMINAL_HISTORY_MAX_BYTES / 4));
    history.append("\nlatest\n");
    expect(history.value()).toBe("latest\n");
  });

  it("joins a split surrogate before eviction and flushes an incomplete stream", () => {
    const history = new BoundedTerminalHistory(5, 4);
    history.append("abc\ud83d");
    expect(history.value()).toBe("abc");
    history.append("\ude42");
    expect(history.value()).toBe("🙂");
    history.append("\ud83d");
    history.finish();
    expect(history.value()).toBe("�");
    expect(history.byteLength).toBe(3);
    history.clear();
    history.append("new stream");
    expect(history.value()).toBe("ream");
  });

  it("matches a reference across random chunk partitions, CRLF, ANSI and Unicode", () => {
    const text = ("\u001b[32m世界🙂\u001b[0m\r\n\n" + "x".repeat(79) + "é🦊\n").repeat(100);
    for (let seed = 1; seed <= 100; seed++) {
      let state = seed;
      const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state;
      };
      const lines = 1 + (random() % 30);
      const bytes = 1 + (random() % 1024);
      const history = new BoundedTerminalHistory(lines, bytes);
      for (let i = 0; i < text.length; ) {
        const end = Math.min(text.length, i + 1 + (random() % 300));
        history.append(text.slice(i, end));
        expect(history.byteLength).toBeLessThanOrEqual(bytes);
        expect(Buffer.byteLength(history.value())).toBe(history.byteLength);
        i = end;
      }
      history.finish();
      expect(history.value()).toBe(reference(text, lines, bytes));
    }
  });

  it("can clear and refill repeatedly without stale cached snapshots", () => {
    const history = new BoundedTerminalHistory(2, 16);
    for (let i = 0; i < 10000; i++) {
      history.append(`${i}\n`);
      if (i % 100 === 0) {
        history.clear();
        expect(history.value()).toBe("");
      }
    }
    expect(history.value()).toBe("9998\n9999\n");
  });
  it("can evict and append after materializing a large snapshot", () => {
    const history = new BoundedTerminalHistory(5000, 16000);
    let text = "🙂".repeat(4000);
    history.append(text);
    expect(history.value()).toBe(text);
    for (let i = 0; i < 100; i++) {
      const next = `${i}世界\n`;
      text = reference(text + next, 5000, 16000);
      history.append(next);
      expect(history.value()).toBe(text);
      expect(history.byteLength).toBe(Buffer.byteLength(text));
    }
  });
});
