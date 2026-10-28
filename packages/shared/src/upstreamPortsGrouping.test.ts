import { describe, expect, it } from "vitest";
import {
  filesOverlap,
  groupPortTopics,
  normalizeArea,
  portFileKeys,
  type PortGroupingTopic,
} from "./upstreamPortsGrouping";

const topic = (
  id: string,
  area = "server",
  fileKeys: string[] | null = [],
  related: string[] = [],
): PortGroupingTopic => ({ id, area, fileKeys, related });
describe("port grouping", () => {
  it("normalizes areas and packs singleton unknowns by area", () => {
    expect(normalizeArea(" Pr _ hub ")).toBe("pr-hub");
    expect(
      groupPortTopics(
        [topic("a", "pr hub", null), topic("b", "pr-hub", null), topic("c", "web", null)],
        "batched",
        5,
      ),
    ).toEqual([["a", "b"], ["c"]]);
  });
  it("joins different areas by file or related topic and ignores external relations", () => {
    const topics = [
      topic("a", "web", ["a.ts"]),
      topic("b", "server", ["a.ts"], ["c"]),
      topic("c", "other", [], ["outside"]),
      topic("d", "web"),
    ];
    expect(groupPortTopics(topics, "batched", 3)).toEqual([["a", "b", "c"], ["d"]]);
    expect(groupPortTopics(topics, "batched", 3)).toEqual(groupPortTopics(topics, "batched", 3));
  });
  it("cuts oversize clusters consecutively without splitting small clusters to fill gaps", () => {
    expect(
      groupPortTopics(
        Array.from({ length: 12 }, (_, i) => topic(String(i), "a", ["shared"])),
        "batched",
        5,
      ).map((group) => group.length),
    ).toEqual([5, 5, 2]);
    const topics = [
      topic("a", "x", ["ab"]),
      topic("b", "x", ["ab"]),
      topic("c", "x", ["cd"]),
      topic("d", "x", ["cd"]),
      topic("e", "x"),
      topic("f", "y"),
    ];
    expect(groupPortTopics(topics, "batched", 3)).toEqual([["a", "b", "e"], ["c", "d"], ["f"]]);
  });
  it("supports direct grouping and empty inputs", () => {
    expect(groupPortTopics([], "together")).toEqual([]);
    expect(groupPortTopics([topic("a"), topic("b")], "together")).toEqual([["a", "b"]]);
    expect(groupPortTopics([topic("a"), topic("b")], "separately")).toEqual([["a"], ["b"]]);
    expect(filesOverlap(["a"], ["b", "a"])).toBe(true);
    expect(filesOverlap([], ["a"])).toBe(false);
  });
});
describe("file keys", () => {
  it("drops lockfiles and paths meeting both hot thresholds", () => {
    const sets = new Map(
      Array.from({ length: 201 }, (_, i) => [
        String(i),
        [
          "bun.lock",
          "nested/pnpm-lock.yaml",
          ...(i < 10 ? ["ten"] : []),
          ...(i < 11 ? ["eleven"] : []),
          ...(i < 9 ? ["nine"] : []),
        ],
      ]),
    );
    const keys = portFileKeys(sets);
    expect(keys.hotPaths.has("ten")).toBe(false);
    expect(keys.hotPaths.has("eleven")).toBe(true);
    expect(keys.keysByTopic.get("0")).toEqual(["ten", "nine"]);
    expect(portFileKeys(new Map([...sets].slice(0, 200))).hotPaths.has("ten")).toBe(true);
  });
});
