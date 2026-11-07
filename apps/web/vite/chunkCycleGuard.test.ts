import { describe, expect, it } from "vitest";

import { chunkCycleGuardPlugin } from "./chunkCycleGuard";

type Graph = Record<string, { imports: string[]; dynamicImports?: string[] }>;

// Only fields read by the hook are needed in these output bundle fixtures.
function checkGraph(graph: Graph, plugin = chunkCycleGuardPlugin()) {
  const hook = plugin.generateBundle;
  if (typeof hook !== "function") throw new Error("Expected a generateBundle hook");
  const bundle = {
    ...Object.fromEntries(
      Object.entries(graph).map(([fileName, edges]) => [
        fileName,
        { type: "chunk", fileName, dynamicImports: [], ...edges },
      ]),
    ),
    "asset.txt": { type: "asset", source: "asset" },
  };
  return Reflect.apply(
    hook,
    {
      error(message: string): never {
        throw new Error(message);
      },
    },
    [{}, bundle, false],
  );
}

describe("chunkCycleGuardPlugin", () => {
  it("rejects a static cycle with its chunk path", () => {
    expect(() =>
      checkGraph({
        "entry.js": { imports: ["utils.js"] },
        "utils.js": { imports: ["icons.js"] },
        "icons.js": { imports: ["utils.js"] },
      }),
    ).toThrow("Chunk import cycle: utils.js -> icons.js -> utils.js");
  });

  it("checks disconnected chunks too", () => {
    expect(() =>
      checkGraph({
        "entry.js": { imports: [] },
        "lazy.js": { imports: ["lazy.js"] },
      }),
    ).toThrow("Chunk import cycle: lazy.js -> lazy.js");
  });

  it("allows shared dependencies, assets, and external imports", () => {
    expect(() =>
      checkGraph({
        "entry.js": { imports: ["left.js", "right.js", "external", "asset.txt"] },
        "left.js": { imports: ["shared.js"] },
        "right.js": { imports: ["shared.js"] },
        "shared.js": { imports: [] },
      }),
    ).not.toThrow();
  });

  it("allows dynamic imports with a static back-reference", () => {
    expect(() =>
      checkGraph({
        "entry.js": { imports: [], dynamicImports: ["lazy.js"] },
        "lazy.js": { imports: ["entry.js"] },
      }),
    ).not.toThrow();
  });

  it("resets traversal state between watch builds", () => {
    const plugin = chunkCycleGuardPlugin();
    checkGraph({ "entry.js": { imports: [] } }, plugin);
    expect(() => checkGraph({ "entry.js": { imports: ["entry.js"] } }, plugin)).toThrow(
      "Chunk import cycle: entry.js -> entry.js",
    );
  });
});
