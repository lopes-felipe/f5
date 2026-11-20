import type { Root, RootContent } from "mdast";
import { collectComposerModelMentions } from "@t3tools/shared/composerModelMentions";
export function remarkModelMentions() {
  return (tree: Root) => {
    const walk = (parent: Root | RootContent) => {
      if (
        ["link", "linkReference", "code", "inlineCode", "html"].includes(parent.type) ||
        !("children" in parent)
      )
        return;
      const children: RootContent[] = [];
      for (const node of parent.children) {
        if (node.type !== "text") {
          walk(node);
          children.push(node);
          continue;
        }
        let cursor = 0;
        for (const mention of collectComposerModelMentions(node.value)) {
          if (mention.start > cursor)
            children.push({ type: "text", value: node.value.slice(cursor, mention.start) });
          children.push({
            type: "link",
            url:
              "f5://model/" +
              encodeURIComponent(mention.instanceId) +
              "/" +
              encodeURIComponent(mention.model),
            children: [{ type: "text", value: mention.raw }],
          });
          cursor = mention.end;
        }
        if (cursor < node.value.length)
          children.push({ type: "text", value: node.value.slice(cursor) });
      }
      parent.children = children as typeof parent.children;
    };
    walk(tree);
  };
}
