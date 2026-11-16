import type { Root } from "mdast";
import { splitGfmAlert } from "@t3tools/shared/markdownAlerts";

/**
 * Turns a top-level `> [!NOTE]` blockquote into an alert: the marker line is
 * removed and the type is exposed as `data-alert` for the blockquote renderer.
 */
export function remarkGfmAlerts() {
  return (tree: Root) => {
    for (const node of tree.children) {
      if (node.type !== "blockquote") continue;
      const alert = splitGfmAlert(node);
      if (!alert) continue;
      node.children = alert.children;
      node.data = {
        ...node.data,
        hProperties: { ...node.data?.hProperties, dataAlert: alert.type },
      };
    }
  };
}
