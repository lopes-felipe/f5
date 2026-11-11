import type { Root, RootContent } from "mdast";

/** Preserve soft newlines in prose while leaving code and HTML nodes alone. */
export function remarkHardLineBreaks() {
  return (tree: Root) => {
    const visit = (parent: { children: RootContent[] }) => {
      parent.children = parent.children.flatMap((node): RootContent[] => {
        if (node.type === "text") {
          return node.value
            .split("\n")
            .flatMap((value, index) =>
              index === 0
                ? [{ type: "text", value }]
                : [{ type: "break" }, { type: "text", value }],
            );
        }
        if ("children" in node) visit(node as { children: RootContent[] });
        return [node];
      });
    };
    visit(tree);
  };
}
