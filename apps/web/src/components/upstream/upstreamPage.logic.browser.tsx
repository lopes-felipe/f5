import { expect, it } from "vitest";

import { isEditableTarget } from "./upstreamPage.logic";

const element = (html: string) => {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild!;
};

it("treats text fields as editable but not row checkboxes", () => {
  expect(isEditableTarget(element('<input type="checkbox" />'))).toBe(false);
  expect(isEditableTarget(element('<input type="radio" />'))).toBe(false);
  expect(isEditableTarget(element("<input />"))).toBe(true);
  expect(isEditableTarget(element('<input type="search" />'))).toBe(true);
  expect(isEditableTarget(element("<textarea></textarea>"))).toBe(true);
  expect(isEditableTarget(element("<select></select>"))).toBe(true);
  expect(isEditableTarget(element('<div contenteditable="true"></div>'))).toBe(true);
  expect(isEditableTarget(element("<button></button>"))).toBe(false);
});
