import { describe, expect, it } from "vitest";
import { CursorTransportFailure } from "./CursorTransportFailure.ts";

describe("CursorTransportFailure", () => {
  const diagnostic = "Error: ConnectError: [unavailable] connection lost";
  it("recognizes a standalone diagnostic across every chunk boundary", () => {
    const text = `${diagnostic}\r\n    at prompt (agent.js:1:1)\n`;
    for (let boundary = 0; boundary <= text.length; boundary++) {
      const parser = new CursorTransportFailure();
      parser.push(text.slice(0, boundary));
      // Reading the partial result must not change subsequent parsing.
      void parser.failure;
      parser.push(text.slice(boundary));
      expect(parser.failure).toBe(diagnostic);
    }
  });

  it.each([
    `The server returned:\n${diagnostic}`,
    `\`\`\`\n${diagnostic}\n\`\`\``,
    `${diagnostic}\nHere is how to fix it.`,
    "Error: RetriableError: [internal] an internal agent diagnostic",
    "x".repeat(5000) + diagnostic,
  ])("keeps ordinary assistant content: %s", (text) => {
    const parser = new CursorTransportFailure();
    for (const character of text) parser.push(character);
    expect(parser.failure).toBeUndefined();
  });
});
