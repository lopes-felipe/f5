import { describe, expect, it } from "vitest";

import { excerptCheckLog } from "./checkLog.ts";

const stamp = (index: number) =>
  `2026-11-14T06:58:${String(index % 60).padStart(2, "0")}.4329374Z `;
const log = (lines: readonly string[]) =>
  `﻿${lines.map((line, index) => `${stamp(index)}${line}`).join("\r\n")}\r\n`;

describe("excerptCheckLog", () => {
  it("removes the byte order mark, timestamps and terminal escapes", () => {
    const result = excerptCheckLog(
      log([
        "##[group]Run bun run lint",
        "\u001B[36;1mbun run lint\u001B[0m",
        "\u001B]0;title\u0007src/a.ts(3,1): error TS2304: Cannot find name 'x'.",
        "##[error]Process completed with exit code 1.",
      ]),
    );
    expect(result.excerpt.split("\n")).toEqual([
      "##[group]Run bun run lint",
      "bun run lint",
      "src/a.ts(3,1): error TS2304: Cannot find name 'x'.",
      "##[error]Process completed with exit code 1.",
    ]);
    expect(result).toMatchObject({ startLine: 1, totalLines: 4, errorLine: 4, truncated: false });
  });

  it("keeps the lines before the first error and a few after it", () => {
    const lines = Array.from({ length: 1000 }, (_, index) => `line ${index + 1}`);
    lines[699] = "##[error]first failure";
    lines[899] = "##[error]second failure";
    const result = excerptCheckLog(log(lines));
    const excerpt = result.excerpt.split("\n");
    expect(excerpt).toHaveLength(200);
    expect(result.errorLine).toBe(700);
    // 20 lines follow the marker, so the excerpt ends at line 720 and starts at 521.
    expect(result.startLine).toBe(521);
    expect(excerpt[0]).toBe("line 521");
    expect(excerpt[179]).toBe("##[error]first failure");
    expect(excerpt.at(-1)).toBe("line 720");
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(1000);
  });

  it("shows more of what follows an error near the top", () => {
    const lines = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`);
    lines[4] = "##[error]early failure";
    const result = excerptCheckLog(log(lines));
    expect(result.startLine).toBe(1);
    expect(result.excerpt.split("\n")).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  it("keeps the end of a log that has no error marker", () => {
    const lines = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`);
    const result = excerptCheckLog(log(lines));
    expect(result.errorLine).toBeNull();
    expect(result.startLine).toBe(101);
    expect(result.excerpt.split("\n").at(-1)).toBe("line 300");
  });

  it("drops the lines farthest from the error to stay under the byte limit", () => {
    const lines = Array.from({ length: 120 }, (_, index) => `${index + 1} ${"x".repeat(990)}`);
    lines[99] = "##[error]the failure";
    const result = excerptCheckLog(log(lines));
    expect(Buffer.byteLength(result.excerpt, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(result.excerpt).toContain("##[error]the failure");
    // The lines right before the marker survive; the oldest ones do not.
    expect(result.excerpt).toContain("\n99 ");
    expect(result.excerpt.startsWith("1 ")).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it("shortens a very long line and handles an empty log", () => {
    const result = excerptCheckLog(log(["a".repeat(5000), "##[error]failed"]));
    expect(result.excerpt.split("\n")[0]).toHaveLength(2001);
    expect(excerptCheckLog("﻿\r\n")).toEqual({
      excerpt: "",
      startLine: 0,
      totalLines: 0,
      errorLine: null,
      truncated: false,
    });
  });
});
