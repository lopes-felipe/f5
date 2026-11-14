import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { upstreamProjectsQueryOptions } from "../lib/upstreamPortsReactQuery";
import { readNativeApi } from "../nativeApi";

/** PR Hub "needs you" count, kept live through the native API. */
export function usePrHubNeedsYouCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const api = readNativeApi();
    if (!api?.prHub) return;

    const updateCount = (snapshot: { counts: { needs_you: number } }) => {
      setCount(snapshot.counts.needs_you);
    };
    void api.prHub
      .getOverview()
      .then(updateCount)
      .catch(() => setCount(0));
    return api.prHub.onChanged(updateCount);
  }, []);
  return count;
}

/** Projects with an `upstream` block and their inbox total; refreshed by `upstreamPorts.changed`. */
export function useUpstreamNav(): { readonly visible: boolean; readonly inbox: number } {
  const query = useQuery({
    ...upstreamProjectsQueryOptions(),
    enabled: Boolean(readNativeApi()?.upstreamPorts),
  });
  const projects = query.data?.projects ?? [];
  return {
    visible: projects.length > 0,
    inbox: projects.reduce(
      (sum, project) => sum + (project.managedByThisProfile ? project.inboxCount : 0),
      0,
    ),
  };
}
