import { describe, expect, it } from "vitest";

import corpus from "./fixtures/readOnlyShellCorpus.json" with { type: "json" };
import { classifyReadOnlyShellCommand } from "./readOnlyWorkflowShell.ts";

/**
 * Commands that read-only workflow stages really ran, one per shape, with private paths and
 * repository names rewritten (`fixtures/readOnlyShellCorpus.json`). The accepted ones are what
 * reviewers need to do their work: a classifier change that starts refusing one of them breaks
 * stages again, so it fails here. The refused ones write, run another program or reach the
 * network, and must stay refused.
 *
 * To re-measure against a larger set of recorded commands, see
 * `scripts/replay-read-only-commands.ts`.
 */
const accepted = corpus.filter((entry) => entry.readOnly).map((entry) => entry.command);
const refused = corpus
  .filter((entry) => !entry.readOnly)
  .map((entry) => [entry.command, entry.reason ?? ""] as const);

describe("recorded read-only stage commands", () => {
  it("holds enough of each kind to mean something", () => {
    expect(accepted.length).toBeGreaterThanOrEqual(100);
    expect(refused.length).toBeGreaterThanOrEqual(30);
  });

  it.each(accepted)("allows %s", (command) => {
    expect(classifyReadOnlyShellCommand(command)).toEqual({ readOnly: true });
  });

  it.each(refused)("refuses %s", (command, reason) => {
    expect(classifyReadOnlyShellCommand(command)).toEqual({ readOnly: false, reason });
  });
});
