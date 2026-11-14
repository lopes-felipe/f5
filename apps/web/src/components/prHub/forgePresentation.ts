import type { SourceControlProviderKind } from "@t3tools/contracts";

export const FORGE_PROVIDERS = [
  ["github", "GitHub", "github.com"],
  ["gitlab", "GitLab", "gitlab.com"],
  ["bitbucket", "Bitbucket Cloud", "bitbucket.org"],
  ["azure-devops", "Azure DevOps", "dev.azure.com"],
  ["forgejo", "Forgejo / Gitea", ""],
] as const;

export const forgeProviderLabel = (provider: SourceControlProviderKind) =>
  FORGE_PROVIDERS.find(([kind]) => kind === provider)?.[1] ?? provider;
