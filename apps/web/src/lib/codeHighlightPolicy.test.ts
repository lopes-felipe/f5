import { describe, expect, it } from "vitest";

import {
  CODE_HIGHLIGHT_ON_DEMAND_MIN_BYTES,
  CODE_HIGHLIGHT_ON_DEMAND_MIN_LINES,
  CODE_HIGHLIGHT_WORKER_MIN_CHARS,
  CODE_HIGHLIGHT_WORKER_MIN_LINES,
  classifyCodeHighlight,
  normalizeFenceLanguage,
} from "./codeHighlightPolicy";

describe("normalizeFenceLanguage", () => {
  it("produces one key per language", () => {
    expect(normalizeFenceLanguage("TypeScript")).toBe("typescript");
    expect(normalizeFenceLanguage("ts{1,3}")).toBe("ts");
    expect(normalizeFenceLanguage("js:title=app.js")).toBe("js");
    expect(normalizeFenceLanguage(" Bash ")).toBe("bash");
    expect(normalizeFenceLanguage("c++")).toBe("c++");
  });

  it("maps aliases and falls back to text for missing or implausible names", () => {
    expect(normalizeFenceLanguage("gitignore")).toBe("ini");
    expect(normalizeFenceLanguage("plaintext")).toBe("text");
    expect(normalizeFenceLanguage(undefined)).toBe("text");
    expect(normalizeFenceLanguage("")).toBe("text");
    expect(normalizeFenceLanguage("<script>")).toBe("text");
    expect(normalizeFenceLanguage("x".repeat(64))).toBe("text");
  });
});

describe("classifyCodeHighlight", () => {
  it("keeps small blocks inline", () => {
    expect(classifyCodeHighlight("const a = 1;\nconst b = 2;")).toBe("inline");
  });

  it("sends large blocks to the worker by size or line count", () => {
    expect(classifyCodeHighlight("x".repeat(CODE_HIGHLIGHT_WORKER_MIN_CHARS + 1))).toBe("worker");
    expect(classifyCodeHighlight("x\n".repeat(CODE_HIGHLIGHT_WORKER_MIN_LINES + 1))).toBe("worker");
  });

  it("renders huge blocks on demand by size or line count", () => {
    expect(classifyCodeHighlight("x".repeat(CODE_HIGHLIGHT_ON_DEMAND_MIN_BYTES + 1))).toBe(
      "on-demand",
    );
    expect(classifyCodeHighlight("\n".repeat(CODE_HIGHLIGHT_ON_DEMAND_MIN_LINES))).toBe(
      "on-demand",
    );
  });
});
