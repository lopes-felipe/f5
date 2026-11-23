import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readClaudeSkillInvocationFlags } from "../orchestration/projectSkills.ts";
import { planClaudeSkillDispatch } from "./claudeSkillDispatch.ts";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "f5-skill-dispatch-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function write(relative: string, content: string) {
  const file = path.join(cwd, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function plan(text: string, nativeCommands?: ReadonlySet<string>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return yield* planClaudeSkillDispatch({
        text,
        cwd,
        fileSystem,
        environment: {
          CLAUDE_CONFIG_DIR: path.join(cwd, "config"),
          CLAUDE_CODE_MANAGED_SETTINGS_PATH: path.join(cwd, "managed.json"),
        },
        nativeCommands,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.each([
  ["yes", "no"],
  ["on", "off"],
  ["1", "0"],
])("reads Claude boolean spellings %s and %s", (enabled, disabled) => {
  expect(
    readClaudeSkillInvocationFlags(
      "---\ndisable-model-invocation: " + enabled + "\nuser-invocable: " + disabled + "\n---\n",
    ),
  ).toEqual({ userInvocationOnly: true, userInvocable: false });
});

it("uses an invocation override before the command catalog is available and skips handoff history", async () => {
  const audit = write(".claude/skills/audit/SKILL.md", "Audit.");
  write("config/skills/report/SKILL.md", "Report.");
  write("managed.json", JSON.stringify({ skillOverrides: { audit: "user-invocable-only" } }));
  const history =
    "Ultrathink:\n<f5-context-handoff v1>\nOld /audit and /report request\n</f5-context-handoff>";
  const dispatch = await plan(history + "\nPlease /audit and /report the findings.");

  expect(dispatch?.leadingText).toBe(
    history +
      "\nPlease /audit [The user invoked this skill. Follow the instructions in " +
      JSON.stringify(audit) +
      ".] and /report the findings.",
  );
  expect(dispatch?.commandText).toBe("/report the findings.");
  expect(await plan("/compact /audit /report")).toBeUndefined();
});

it("looks up plugin skills in declared directories within the install", async () => {
  const installPath = path.join(cwd, "config", "plugins", "tools");
  write(
    "config/plugins/installed_plugins.json",
    JSON.stringify({
      version: 2,
      plugins: { "tools@test": [{ scope: "user", installPath }] },
    }),
  );
  write(
    "config/plugins/tools/.claude-plugin/plugin.json",
    JSON.stringify({
      skills: ["../../../outside", "./custom"],
    }),
  );
  write("outside/audit/SKILL.md", "---\ndisable-model-invocation: yes\n---\nOutside.");
  const audit = write(
    "config/plugins/tools/custom/audit/SKILL.md",
    "---\ndisable-model-invocation: yes\n---\nAudit.",
  );
  write("config/skills/report/SKILL.md", "Report.");
  const dispatch = await plan("/tools:audit and /report", new Set(["tools:audit", "report"]));
  expect(dispatch?.leadingText).toContain(JSON.stringify(audit));
  expect(dispatch?.commandText).toBe("/report");
});
