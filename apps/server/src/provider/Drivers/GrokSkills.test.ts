import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as runner from "../../processRunner.ts";
import { discoverGrokSkills, discoverGlobalGrokSkills, parseGrokSkills } from "./GrokSkills.ts";

describe("Grok skill inventory", () => {
  it("preserves disabled skills and lets project definitions win", () => {
    const skills = parseGrokSkills(
      JSON.stringify({
        skills: [
          { name: "review", source: { path: "/plugin/SKILL.md", type: "plugin" } },
          {
            name: "review",
            description: "Project review",
            source: { path: "/repo/SKILL.md", type: "project" },
          },
          { name: "hidden", userInvocable: false, source: { path: "/hidden/SKILL.md" } },
          { name: "invalid" },
        ],
      }),
    );
    expect(skills).toMatchObject([
      { name: "hidden", enabled: false },
      { name: "review", path: "/repo/SKILL.md", scope: "project" },
    ]);
    expect(parseGrokSkills("not JSON")).toEqual([]);
    expect(parseGrokSkills('{"skills": [null, 1]}')).toEqual([]);
  });
  it("bounds CLI output and treats unsupported or failed inspect as unavailable", async () => {
    const run = vi.spyOn(runner, "runProcess").mockRejectedValue(new Error("unsupported"));
    try {
      expect(
        await Effect.runPromise(
          discoverGrokSkills({ binaryPath: "custom-grok" }, { PATH: "/bin" }, "/repo"),
        ),
      ).toEqual([]);
      expect(run).toHaveBeenCalledWith(
        "custom-grok",
        ["inspect", "--json"],
        expect.objectContaining({
          cwd: "/repo",
          timeoutMs: 4000,
          maxBufferBytes: 1024 * 1024,
          outputMode: "error",
        }),
      );
    } finally {
      run.mockRestore();
    }
  });
});

it("does not run global inventory in the server checkout", async () => {
  const run = vi.spyOn(runner, "runProcess").mockResolvedValue({
    code: 0,
    signal: null,
    stdout: JSON.stringify({
      skills: [
        { name: "local", source: { type: "project", path: "/project/SKILL.md" } },
        { name: "plugin", source: { type: "plugin", path: "/plugin/SKILL.md" } },
      ],
    }),
    stderr: "",
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  try {
    const skills = await Effect.runPromise(discoverGlobalGrokSkills({ binaryPath: "grok" }, {}));
    expect(skills.map((skill) => skill.name)).toEqual(["plugin"]);
    expect(run.mock.calls[0]?.[2]?.cwd).not.toBe(process.cwd());
  } finally {
    run.mockRestore();
  }
});

it("preserves qualified invocations when plugins and local skills share a name", () => {
  const skills = parseGrokSkills(
    JSON.stringify({
      skills: [
        {
          name: "commit",
          invocableAs: "local:commit",
          source: { path: "/local/SKILL.md", type: "project" },
        },
        {
          name: "commit",
          invocableAs: "acme:commit",
          source: { path: "/plugin/SKILL.md", type: "plugin" },
        },
      ],
    }),
  );
  expect(skills.map(({ name }) => name)).toEqual(["acme:commit", "local:commit"]);
});
