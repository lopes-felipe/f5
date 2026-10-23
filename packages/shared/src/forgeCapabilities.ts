import type { ForgeCapabilities, SourceControlProviderKind } from "@t3tools/contracts";

type ForgeKind = Exclude<SourceControlProviderKind, "github" | "unknown">;
const COMMON = {
  diff: true,
  labels: false,
  viewedFiles: "f5",
  stacks: false,
  stackActions: false,
  edit: { changeRequest: true, comment: true },
  reviewers: { request: true, listCandidates: true },
} as const;
export const FORGE_CAPABILITIES: Readonly<Record<ForgeKind, ForgeCapabilities>> = {
  gitlab: {
    ...COMMON,
    comment: true,
    actions: [
      "merge",
      "ready",
      "draft",
      "close",
      "reopen",
      "update-branch",
      "enable-auto-merge",
      "disable-auto-merge",
    ],
    mergeMethods: ["merge", "squash", "rebase"],
    updateMethods: ["rebase"],
    search: true,
    reactions: true,
    review: { inlineComment: true, reply: true, resolve: true, verdicts: ["comment", "approve"] },
  },
  bitbucket: {
    ...COMMON,
    comment: true,
    actions: ["close"],
    mergeMethods: [],
    updateMethods: [],
    search: true,
    reactions: false,
    review: {
      inlineComment: true,
      reply: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"],
    },
  },
  "azure-devops": {
    ...COMMON,
    comment: false,
    actions: [
      "merge",
      "ready",
      "draft",
      "close",
      "reopen",
      "enable-auto-merge",
      "disable-auto-merge",
    ],
    mergeMethods: ["merge", "squash"],
    updateMethods: [],
    search: false,
    reactions: false,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: true, listCandidates: false },
    edit: { changeRequest: true, comment: false },
  },
  forgejo: {
    ...COMMON,
    comment: true,
    actions: ["merge", "close", "reopen", "update-branch"],
    mergeMethods: ["merge", "squash", "rebase"],
    updateMethods: ["merge", "rebase"],
    search: false,
    reactions: true,
    labels: true,
    review: {
      inlineComment: true,
      reply: false,
      resolve: false,
      verdicts: ["comment", "approve", "request-changes"],
    },
  },
};
export const GITHUB_FORGE_CAPABILITIES: ForgeCapabilities = {
  ...COMMON,
  viewedFiles: "host",
  comment: true,
  labels: true,
  actions: [
    "delete-branch",
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
    "revert",
    "approve-workflows",
  ],
  mergeMethods: ["merge", "squash", "rebase"],
  updateMethods: ["merge", "rebase"],
  search: true,
  reactions: true,
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  stacks: true,
  stackActions: true,
};

export const forgeCapabilitiesFor = (
  provider: SourceControlProviderKind,
): ForgeCapabilities | null =>
  provider === "github"
    ? GITHUB_FORGE_CAPABILITIES
    : provider === "unknown"
      ? null
      : FORGE_CAPABILITIES[provider];
