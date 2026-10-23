import { expect, it } from "vitest";
import { highlightThreadFind, threadFindRanges } from "./threadFindHighlights";

it("matches across inline spans without joining separate blocks or hidden controls", () => {
  const root = document.createElement("div");
  root.innerHTML =
    '<h2 class="sr-only">Needle</h2><p>Hello <strong>bold</strong> world</p><p>Other</p><button>Needle</button><pre><span>const </span><span>value</span> = 1</pre>';
  expect(threadFindRanges(root, "bold world").ranges.map((range) => range.toString())).toEqual([
    "bold world",
  ]);
  expect(threadFindRanges(root, "worldOther").ranges).toHaveLength(0);
  expect(threadFindRanges(root, "Needle").ranges).toHaveLength(0);
  expect(threadFindRanges(root, "const value").selected?.toString()).toBe("const value");
});
it("bounds highlighted ranges while retaining a later selected occurrence and Unicode offsets", () => {
  const root = document.createElement("div");
  root.textContent = "İ ΟΣ " + "needle ".repeat(3000);
  const result = threadFindRanges(root, "needle", 2999);
  expect(result.ranges).toHaveLength(2000);
  expect(result.selected?.toString()).toBe("needle");
  expect(result.selected?.startOffset).toBe(5 + 2999 * 7);
  expect(threadFindRanges(root, "σ").selected?.toString()).toBe("Σ");
});
it("keeps a newer highlight owner when an older row releases its highlights", () => {
  const root = document.createElement("div");
  root.textContent = "one two";
  const old = highlightThreadFind(root, "one", 0);
  const current = highlightThreadFind(root, "two", 0);
  old();
  expect([...CSS.highlights.get("f5-thread-find-active")!][0]?.toString()).toBe("two");
  current();
  expect(CSS.highlights.has("f5-thread-find-active")).toBe(false);
});
