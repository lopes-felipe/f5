import { createContext } from "react";
import type { SourceControlProviderIdentity, ThreadPullRequestLink } from "@t3tools/contracts";
import type { RepositoryLinkContext } from "./lib/remarkIssueReferences";

export const RepositoryLinks = createContext<RepositoryLinkContext | null>(null);

export function repositoryLinksForThread(
  pr?: Pick<ThreadPullRequestLink, "url" | "provider">,
  remote?: SourceControlProviderIdentity,
): RepositoryLinkContext | null {
  if (pr) {
    try {
      const url = new URL(pr.url);
      if (pr.provider === "azure-devops")
        url.pathname = url.pathname.replace(/\/pullrequest\/\d+.*$/, "");
      else
        url.pathname = url.pathname.replace(
          /\/(?:-\/)?(?:pull|pulls|merge_requests|pull-requests)\/\d+.*$/,
          "",
        );
      url.search = "";
      url.hash = "";
      return { provider: pr.provider, webUrl: url.href };
    } catch {
      return null;
    }
  }
  return remote?.webUrl ? { provider: remote.kind, webUrl: remote.webUrl } : null;
}
