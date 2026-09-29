import type { Root, RootContent, PhrasingContent } from "mdast";

export interface RepositoryLinkContext {
  provider: string;
  webUrl: string;
}

export function issueReferenceUrl(
  context: RepositoryLinkContext,
  number: string,
  qualified?: string,
): string | null {
  if (
    !["github", "gitlab", "bitbucket", "forgejo", "gitea", "azure-devops"].includes(
      context.provider,
    )
  )
    return null;
  try {
    const url = new URL(context.webUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    let path = url.pathname.replace(/\/$/, "").replace(/\.git$/, "");
    if (qualified) path = "/" + qualified.split("/").map(encodeURIComponent).join("/");
    if (context.provider === "azure-devops") {
      if (qualified || !path.includes("/_git/")) return null;
      path = path.split("/_git/")[0] + "/_workitems/edit/" + number;
    } else path += (context.provider === "gitlab" ? "/-/issues/" : "/issues/") + number;
    url.pathname = path;
    return url.href;
  } catch {
    return null;
  }
}

/** Link text nodes only; code, HTML and existing links retain their original bytes. */
export function remarkIssueReferences(context: RepositoryLinkContext | null) {
  return (tree: Root) => {
    if (!context) return;
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
        const regex = /(?<![\w/#])(?:([\w.-]+(?:\/[\w.-]+)+))?#([1-9]\d*)\b/g;
        let offset = 0;
        for (const match of node.value.matchAll(regex)) {
          const url = issueReferenceUrl(context, match[2]!, match[1]);
          if (!url) continue;
          if (match.index > offset)
            children.push({ type: "text", value: node.value.slice(offset, match.index) });
          children.push({ type: "link", url, children: [{ type: "text", value: match[0] }] });
          offset = match.index + match[0].length;
        }
        if (!offset) children.push(node);
        else if (offset < node.value.length)
          children.push({ type: "text", value: node.value.slice(offset) });
      }
      // Every replacement of a text node remains phrasing content.
      parent.children = children as PhrasingContent[] & RootContent[];
    };
    walk(tree);
  };
}
