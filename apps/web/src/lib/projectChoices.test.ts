import { expect, it } from "vitest";
import { projectChoices } from "./projectChoices";

it("keeps pinned projects first, filters archives and preserves relative order", () => {
  const projects = [
    { id: "a" },
    { id: "b", pinned: true },
    { id: "c", archived: true, pinned: true },
    { id: "d", pinned: true },
    { id: "e" },
  ];
  expect(projectChoices(projects).map((project) => project.id)).toEqual(["b", "d", "a", "e"]);
  expect(projects.map((project) => project.id)).toEqual(["a", "b", "c", "d", "e"]);
});
