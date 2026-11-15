import { expect, it } from "vitest";
import { markdownContinuation } from "./markdownContinuation";

it.each([
  ["1. First", "\n2. "],
  ["9) Nine", "\n10) "],
  ["1.", "\n2. "],
  ["  - Nested", "\n  - "],
  ["* Item", "\n* "],
  ["+ Item", "\n+ "],
  ["- [x] Done", "\n- [ ] "],
  ["2. [X] Done", "\n3. [ ] "],
  ["> Quote", "\n> "],
  ["> > Quote", "\n> > "],
  ["> 1. Quoted list", "\n> 2. "],
  ["    indented", "\n    "],
])("continues %s", (value, text) => {
  expect(markdownContinuation(value, value.length)).toEqual({ removeBefore: 0, text });
});
it.each(["1. ", "- ", "- [ ] ", "> "])("exits an empty marker %s", (value) => {
  expect(markdownContinuation(value, value.length)).toEqual({
    removeBefore: value.length,
    text: "",
  });
});
it("leaves ordinary text and fenced code unchanged", () => {
  for (const value of ["text", "```md\n1. literal", "~~~md\n- literal"]) {
    expect(markdownContinuation(value, value.length)).toBeNull();
  }
});
it("resumes lists after a closed fence and uses the caret's line", () => {
  const value = "~~~\ncode\n~~~\n1. First\nTail";
  expect(markdownContinuation(value, value.indexOf("\nTail"))).toEqual({
    removeBefore: 0,
    text: "\n2. ",
  });
});

it.each([
  "```\n```still-code\n1. literal",
  "~~~\n~~~still-code\n1. literal",
  "> ```ts\n> 1. literal",
  "> > ~~~~\n> > ~~~\n> > - literal",
])("does not continue lists inside a fenced container: %s", (value) => {
  expect(markdownContinuation(value, value.length)).toBeNull();
});

it.each(["> ```\n> code\n> ```   \n> 1. Next", "> ```\n> code\n1. Next"])(
  "continues lists after leaving or closing a quoted fence: %s",
  (value) => {
    expect(markdownContinuation(value, value.length)?.text).toBe(
      value.endsWith("> 1. Next") ? "\n> 2. " : "\n2. ",
    );
  },
);
