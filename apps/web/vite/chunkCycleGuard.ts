import type { Plugin } from "vite";

// A static chunk cycle can evaluate imports before their values exist and blank
// the app at boot. Reject it before shipping the bundle.
export function chunkCycleGuardPlugin(): Plugin {
  return {
    name: "f5:chunk-cycle-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      const done = new Set<string>();
      const path: string[] = [];
      const active = new Map<string, number>();
      const visit = (fileName: string) => {
        if (done.has(fileName)) return;
        const start = active.get(fileName);
        if (start !== undefined) {
          this.error("Chunk import cycle: " + [...path.slice(start), fileName].join(" -> "));
        }
        const chunk = bundle[fileName];
        if (chunk?.type !== "chunk") return;
        active.set(fileName, path.length);
        path.push(fileName);
        for (const imported of chunk.imports) visit(imported);
        path.pop();
        active.delete(fileName);
        done.add(fileName);
      };
      for (const fileName of Object.keys(bundle)) visit(fileName);
    },
  };
}
