import type { Disposition, FrozenCommit, LedgerEntry } from "./upstream-port-ledger.ts";

interface SuggestedDisposition {
  readonly disposition: Disposition;
  readonly reason: string;
  readonly plannedWorkstream?: string;
}

const plannedPhaseByPrefix: Readonly<Record<string, SuggestedDisposition>> = {
  fbd77420: {
    disposition: "deferred",
    reason: "Scheduled for original port item 1.1 four runtime modes; implementation pending.",
    plannedWorkstream: "1.1 four runtime modes",
  },
  "40c0ab08": {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 1.2 Codex launch arguments and launch identity; implementation pending.",
    plannedWorkstream: "1.2 Codex launch arguments and launch identity",
  },
  a6c9b41f: {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 1.3 provider-visible pasted-image paths; implementation pending.",
    plannedWorkstream: "1.3 provider-visible pasted-image paths",
  },
  c8ad4b81: {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 1.5 Windows ~/.local/bin resolution; implementation pending.",
    plannedWorkstream: "1.5 Windows ~/.local/bin resolution",
  },
  "749baec3": {
    disposition: "deferred",
    reason: "Scheduled for original port item 1.6 background task names; implementation pending.",
    plannedWorkstream: "1.6 background task names",
  },
  "7963cc70": {
    disposition: "deferred",
    reason: "Scheduled for original port item 1.7 runtime mode per turn; implementation pending.",
    plannedWorkstream: "1.7 runtime mode per turn",
  },
  "887dd6e4": {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 2.1 WebSocket compression and backpressure; implementation pending.",
    plannedWorkstream: "2.1 WebSocket compression and backpressure",
  },
  "8de0aa24": {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 2.4 non-blocking Windows PATH hydration; implementation pending.",
    plannedWorkstream: "2.4 non-blocking Windows PATH hydration",
  },
  "34b15a9a": {
    disposition: "deferred",
    reason: "Scheduled for original port item 2.5 Git metadata caching; implementation pending.",
    plannedWorkstream: "2.5 Git metadata caching",
  },
  "5fcdefd0": {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 2.6 dead replayEvents RPC removal; implementation pending.",
    plannedWorkstream: "2.6 dead replayEvents RPC removal",
  },
  a0419812: {
    disposition: "deferred",
    reason: "Scheduled for original port item 3.1 pins and snoozes; implementation pending.",
    plannedWorkstream: "3.1 pins and snoozes",
  },
  "202e5609": {
    disposition: "deferred",
    reason: "Scheduled for original port item 3.1 pins and snoozes; implementation pending.",
    plannedWorkstream: "3.1 pins and snoozes",
  },
  "9afef94a": {
    disposition: "deferred",
    reason: "Scheduled for original port item 3.1 pins and snoozes; implementation pending.",
    plannedWorkstream: "3.1 pins and snoozes",
  },
  "5661c611": {
    disposition: "deferred",
    reason: "Scheduled for original port item 3.1 pins and snoozes; implementation pending.",
    plannedWorkstream: "3.1 pins and snoozes",
  },
  "61b51ae0": {
    disposition: "deferred",
    reason: "Scheduled for original port item 3.1 pins and snoozes; implementation pending.",
    plannedWorkstream: "3.1 pins and snoozes",
  },
  da6e1a96: {
    disposition: "deferred",
    reason: "Scheduled for original port item 3.1 pins and snoozes; implementation pending.",
    plannedWorkstream: "3.1 pins and snoozes",
  },
  "5c9358ac": {
    disposition: "deferred",
    reason: "Scheduled for original port item 3.2 race-safe titles; implementation pending.",
    plannedWorkstream: "3.2 race-safe titles",
  },
  d37a9b09: {
    disposition: "deferred",
    reason: "Scheduled for original port item 3.2 title regeneration; implementation pending.",
    plannedWorkstream: "3.2 title regeneration",
  },
  b2ee17d7: {
    disposition: "deferred",
    reason: "Scheduled for original port item 3.3 shared thread actions; implementation pending.",
    plannedWorkstream: "3.3 shared thread actions",
  },
  "65b005f1": {
    disposition: "deferred",
    reason: "Scheduled for original port item 3.3 shared thread actions; implementation pending.",
    plannedWorkstream: "3.3 shared thread actions",
  },
  f2d2fb2f: {
    disposition: "deferred",
    reason: "Scheduled for original port item 3.4 durable prompt stash; implementation pending.",
    plannedWorkstream: "3.4 durable prompt stash",
  },
  "200fa826": {
    disposition: "deferred",
    reason: "Scheduled for original port item 3.4 prompt stash; implementation pending.",
    plannedWorkstream: "3.4 prompt stash",
  },
  "752acbf6": {
    disposition: "deferred",
    reason: "Scheduled for original port item 3.5 new-thread affordances; implementation pending.",
    plannedWorkstream: "3.5 new-thread affordances",
  },
  bdf99c17: {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 3.5 new-window thread creation; implementation pending.",
    plannedWorkstream: "3.5 new-window thread creation",
  },
  "239ef1c5": {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 3.5 new-thread shortcut copy; implementation pending.",
    plannedWorkstream: "3.5 new-thread shortcut copy",
  },
  "51672b6e": {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 4.1 diff presentation policy; implementation pending.",
    plannedWorkstream: "4.1 diff presentation policy",
  },
  eea3ea4c: {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 4.1 diff presentation policy; implementation pending.",
    plannedWorkstream: "4.1 diff presentation policy",
  },
  "38cfc25e": {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 4.1 diff presentation policy; implementation pending.",
    plannedWorkstream: "4.1 diff presentation policy",
  },
  cbe80520: {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 4.2 pasted-image compression; implementation pending.",
    plannedWorkstream: "4.2 pasted-image compression",
  },
  f9730979: {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 4.2 deferred base64 encoding; implementation pending.",
    plannedWorkstream: "4.2 deferred base64 encoding",
  },
  "8ca4eec9": {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 4.3 explorer drag into composer; implementation pending.",
    plannedWorkstream: "4.3 explorer drag into composer",
  },
  "4cfec8c1": {
    disposition: "deferred",
    reason: "Scheduled for original port item 4.3 explorer context menus; implementation pending.",
    plannedWorkstream: "4.3 explorer context menus",
  },
  bfc31507: {
    disposition: "deferred",
    reason: "Scheduled for original port item 4.4 sidebar thread search; implementation pending.",
    plannedWorkstream: "4.4 sidebar thread search",
  },
  "4b71a2ae": {
    disposition: "deferred",
    reason: "Scheduled for original port item 4.4 global full-text search; implementation pending.",
    plannedWorkstream: "4.4 global full-text search",
  },
  "1735e27d": {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 4.5 terminal selection actions; implementation pending.",
    plannedWorkstream: "4.5 terminal selection actions",
  },
  "5719e8ac": {
    disposition: "deferred",
    reason: "Scheduled for original port item 4.6 fast-mode icon; implementation pending.",
    plannedWorkstream: "4.6 fast-mode icon",
  },
  "05eb0511": {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 4.7 unsent drafts in sidebar; implementation pending.",
    plannedWorkstream: "4.7 unsent drafts in sidebar",
  },
  b73232bd: {
    disposition: "deferred",
    reason: "Scheduled for original port item 4.8 reset sidebar width; implementation pending.",
    plannedWorkstream: "4.8 reset sidebar width",
  },
  b54bfc93: {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 4.9 right-panel empty states; implementation pending.",
    plannedWorkstream: "4.9 right-panel empty states",
  },
  abc409c2: {
    disposition: "deferred",
    reason: "Scheduled for original port item 5.2 project content search; implementation pending.",
    plannedWorkstream: "5.2 project content search",
  },
  e5c75470: {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 5.3 settings search and deep links; implementation pending.",
    plannedWorkstream: "5.3 settings search and deep links",
  },
  "1c9a6de2": {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 5.4 checked-in project configuration; implementation pending.",
    plannedWorkstream: "5.4 checked-in project configuration",
  },
  "6dbffa02": {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 5.5 per-project workspace mode; implementation pending.",
    plannedWorkstream: "5.5 per-project workspace mode",
  },
  "076e9048": {
    disposition: "deferred",
    reason: "Scheduled for original port item 5.6 manual project icons; implementation pending.",
    plannedWorkstream: "5.6 manual project icons",
  },
  "10bca3f4": {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 5.7 source-control writing preferences; implementation pending.",
    plannedWorkstream: "5.7 source-control writing preferences",
  },
  a2ca89aa: {
    disposition: "deferred",
    reason: "Scheduled for original port item 6.2 Agents observability; implementation pending.",
    plannedWorkstream: "6.2 Agents observability",
  },
  c2f8cb7c: {
    disposition: "deferred",
    reason: "Scheduled for original port item 6.2 running subagent count; implementation pending.",
    plannedWorkstream: "6.2 running subagent count",
  },
  "3da315e7": {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 7.1 bounded activity payloads; implementation pending.",
    plannedWorkstream: "7.1 bounded activity payloads",
  },
  b4680cbf: {
    disposition: "deferred",
    reason: "Scheduled for original port item 7.1 activity pagination; implementation pending.",
    plannedWorkstream: "7.1 activity pagination",
  },
  "6b73b3de": {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 7.2 anchored thread pagination; implementation pending.",
    plannedWorkstream: "7.2 anchored thread pagination",
  },
  "8101cd04": {
    disposition: "deferred",
    reason: "Scheduled for original port item 7.3 usage reporting; implementation pending.",
    plannedWorkstream: "7.3 usage reporting",
  },
  c842c6f5: {
    disposition: "deferred",
    reason: "Scheduled for original port item 7.3 hourly usage reporting; implementation pending.",
    plannedWorkstream: "7.3 hourly usage reporting",
  },
  "0ce7e56e": {
    disposition: "deferred",
    reason: "Scheduled for original port item 7.4 PR details; implementation pending.",
    plannedWorkstream: "7.4 PR details",
  },
  "91a03e07": {
    disposition: "deferred",
    reason: "Scheduled for original port item 7.4 PR details; implementation pending.",
    plannedWorkstream: "7.4 PR details",
  },
  cad2c936: {
    disposition: "deferred",
    reason:
      "Scheduled for original port item 7.4 provider-neutral PR seam; implementation pending.",
    plannedWorkstream: "7.4 provider-neutral PR seam",
  },
  "4f584da0": {
    disposition: "deferred",
    reason: "Scheduled for original port item 8.1 appearance settings; implementation pending.",
    plannedWorkstream: "8.1 appearance settings",
  },
  "8eca2000": {
    disposition: "deferred",
    reason: "Scheduled for original port item 8.1 configurable fonts; implementation pending.",
    plannedWorkstream: "8.1 configurable fonts",
  },
  "85b1734d": {
    disposition: "deferred",
    reason: "Scheduled for original port item 8.2 theme library; implementation pending.",
    plannedWorkstream: "8.2 theme library",
  },
  "083fa4ab": {
    disposition: "deferred",
    reason: "Scheduled for original port item 8.2 OKLCH themes; implementation pending.",
    plannedWorkstream: "8.2 OKLCH themes",
  },
  f0b57ca2: {
    disposition: "deferred",
    reason: "Scheduled for original port item 8.2 theme import/search; implementation pending.",
    plannedWorkstream: "8.2 theme import/search",
  },
  b91a000a: {
    disposition: "deferred",
    reason: "Scheduled for original port item 8.2 theme duplication; implementation pending.",
    plannedWorkstream: "8.2 theme duplication",
  },
  "710fd0ee": {
    disposition: "deferred",
    reason: "Scheduled for original port item 8.3 preview favicons; implementation pending.",
    plannedWorkstream: "8.3 preview favicons",
  },
  "72d673a8": {
    disposition: "deferred",
    reason: "Scheduled for original port item 8.3 preview recents; implementation pending.",
    plannedWorkstream: "8.3 preview recents",
  },
  "79fe11bc": {
    disposition: "deferred",
    reason: "Scheduled for original port item 8.3 preview color scheme; implementation pending.",
    plannedWorkstream: "8.3 preview color scheme",
  },
  "1f279732": {
    disposition: "deferred",
    reason: "Scheduled for original port item 8.4 update release notes; implementation pending.",
    plannedWorkstream: "8.4 update release notes",
  },
};

const explicitNonPortsByPrefix: Readonly<Record<string, SuggestedDisposition>> = {
  "7e01d33f": {
    disposition: "not-applicable",
    reason: "Already equivalent: f5 uses a narrow desktop asar unpack list.",
  },
  db1507e9: {
    disposition: "not-applicable",
    reason: "Not applicable: f5 archives explicitly and has no automatic sidebar settling.",
  },
  "31891a1a": {
    disposition: "not-applicable",
    reason: "Divergent direction: f5 deliberately retains plan mode and streaming.",
  },
  "48aa875c": {
    disposition: "not-applicable",
    reason: "Divergent direction: f5 deliberately retains the Build/Plan composer control.",
  },
  e60821f0: {
    disposition: "not-applicable",
    reason: "Divergent direction: f5 model preferences already address model-menu crowding.",
  },
  "2f41c073": {
    disposition: "not-applicable",
    reason: "Divergent direction: f5 deliberately inherits new-thread workspace context.",
  },
  "95305c36": {
    disposition: "not-applicable",
    reason:
      "Rejected on security grounds: browser-local executable selection would be privilege escalation.",
  },
  acf761b2: {
    disposition: "deferred",
    reason: "Deferred pending a cross-platform Ghostty/Electron packaging spike.",
  },
  b28f9bf0: {
    disposition: "deferred",
    reason: "Deferred until the provider-neutral GitHub PR detail seam is complete.",
  },
};

function resolvePrefix<T>(sha: string, values: Readonly<Record<string, T>>): T | undefined {
  for (const [prefix, value] of Object.entries(values)) {
    if (sha.startsWith(prefix)) return value;
  }
  return undefined;
}

export function classifyCommit(commit: FrozenCommit): LedgerEntry {
  const suggestion =
    resolvePrefix(commit.sha, explicitNonPortsByPrefix) ??
    resolvePrefix(commit.sha, plannedPhaseByPrefix);
  return {
    upstreamSha: commit.sha,
    subject: commit.subject,
    reviewStatus: "pending",
    ...(suggestion ?? {
      disposition: "deferred",
      reason: "Requires manual f5-native user-impact assessment.",
    }),
  };
}
