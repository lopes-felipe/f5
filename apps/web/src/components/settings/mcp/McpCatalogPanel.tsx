import type { McpCatalogEntry, McpSearchCatalogResult } from "@t3tools/contracts";
import {
  mcpCatalogDraft,
  mcpCatalogOptions,
  type McpCatalogChoice,
  type McpCatalogDraft,
} from "@t3tools/shared/mcpCatalog";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ensureNativeApi } from "../../../nativeApi";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { readErrorMessage } from "./mcpSettingsHelpers";

const SEARCH_DEBOUNCE_MS = 350;

/**
 * Searches the official MCP Registry. F5 only asks the registry when this panel is
 * open or searched. Choosing an entry fills the Add form for review; nothing is
 * saved or run from here.
 */
export function McpCatalogPanel(props: { onChoose: (draft: McpCatalogDraft) => void }) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  const search = useInfiniteQuery({
    queryKey: ["mcp", "catalog", { projectId: null, query }] as const,
    initialPageParam: undefined as string | undefined,
    staleTime: 60 * 60 * 1000,
    queryFn: ({ pageParam, signal }): Promise<McpSearchCatalogResult> =>
      ensureNativeApi().mcp.searchCatalog(
        { ...(query ? { query } : {}), ...(pageParam ? { cursor: pageParam } : {}) },
        { signal },
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
  const entries = search.data?.pages.flatMap((page) => page.entries) ?? [];

  const choose = (entry: McpCatalogEntry, choice: McpCatalogChoice) =>
    props.onChoose(mcpCatalogDraft(entry, choice));

  return (
    <div className="space-y-3">
      <Input
        type="search"
        aria-label="Search the MCP Registry"
        placeholder="Search the MCP Registry"
        value={input}
        onChange={(event) => setInput(event.currentTarget.value)}
      />
      <p className="text-muted-foreground text-xs">
        From the official MCP Registry. Anyone can publish there, so check a server before adding
        it. Choosing one fills the form; nothing is saved or started until you save.
      </p>
      {search.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {readErrorMessage(search.error)}
        </p>
      ) : null}
      {search.isPending ? <p className="text-muted-foreground text-sm">Searching…</p> : null}
      {!search.isPending && !search.isError && entries.length === 0 ? (
        <p className="text-muted-foreground text-sm">No servers F5 can add match this search.</p>
      ) : null}
      <ul aria-label="Catalog results" className="divide-y divide-border rounded-lg border">
        {entries.map((entry) => (
          <li key={`${entry.name}@${entry.version ?? ""}`} className="space-y-1.5 p-3">
            <div className="flex items-baseline gap-2">
              <span className="font-medium text-sm">{entry.title || entry.name}</span>
              {entry.version ? (
                <span className="text-muted-foreground text-xs">{entry.version}</span>
              ) : null}
              {entry.repositoryUrl || entry.websiteUrl ? (
                <a
                  className="ml-auto inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
                  href={entry.repositoryUrl || entry.websiteUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Source <ExternalLinkIcon className="size-3" />
                </a>
              ) : null}
            </div>
            {entry.title ? (
              <p className="font-mono text-muted-foreground text-xs">{entry.name}</p>
            ) : null}
            {entry.description ? <p className="text-sm">{entry.description}</p> : null}
            <div className="flex flex-wrap gap-2 pt-1">
              {mcpCatalogOptions(entry).map((option) => (
                <Button
                  key={`${option.choice.kind}:${option.choice.index}`}
                  size="sm"
                  variant="outline"
                  aria-label={`Use ${entry.title || entry.name}: ${option.label}`}
                  onClick={() => choose(entry, option.choice)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {search.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          disabled={search.isFetchingNextPage}
          onClick={() => void search.fetchNextPage()}
        >
          {search.isFetchingNextPage ? "Loading…" : "More results"}
        </Button>
      ) : null}
    </div>
  );
}
