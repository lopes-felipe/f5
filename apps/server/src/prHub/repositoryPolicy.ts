import type { ServerSettings } from "@t3tools/contracts";
/** The exclusion is repository-wide and applies to automatic reads as well as inbox tracking. */
export function isPrHubRepositoryExcluded(
  settings: Pick<ServerSettings, "prHub">,
  repository: string,
): boolean {
  return settings.prHub.excludeRepos.some(
    (entry) => entry.trim().toLowerCase() === repository.toLowerCase(),
  );
}
