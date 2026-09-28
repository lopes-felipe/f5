import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  isSafeProjectSkillDirectoryName,
  parseClaudeSkillDocument,
  scanProjectSkills,
} from "./projectSkills.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");

function createTempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), "project-skills-"));
}

function writeSkill(rootPath: string, segments: string[], content: string) {
  const skillDir = path.join(rootPath, ...segments);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), content);
  return skillDir;
}

async function runScan(input: { readonly userHome: string; readonly workspaceRoot: string }) {
  return await Effect.runPromise(
    scanProjectSkills({
      projectId: PROJECT_ID,
      userHome: input.userHome,
      workspaceRoot: input.workspaceRoot,
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

describe("projectSkills", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("discovers provider directories and prefers a project skill over a user skill", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    const userHome = path.join(root, "home");
    const workspaceRoot = path.join(root, "repo");
    writeSkill(
      userHome,
      [".codex", "skills", "review"],
      "---\ndescription: User review\n---\nReview.",
    );
    writeSkill(
      workspaceRoot,
      [".agents", "skills", "review"],
      "---\ndescription: Project review\n---\nReview.",
    );
    writeSkill(
      workspaceRoot,
      [".opencode", "skills", "deploy"],
      "---\ndescription: Deploy\n---\nDeploy.",
    );
    const result = await runScan({ userHome, workspaceRoot });
    expect(result.skills.filter((skill) => skill.commandName === "review")).toHaveLength(1);
    expect(result.skills.find((skill) => skill.commandName === "review")?.scope).toBe("project");
    expect(result.skills.some((skill) => skill.commandName === "deploy")).toBe(true);
  });
  it("keeps provider-native definitions on a same-scope collision", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    const userHome = path.join(root, "home");
    const workspaceRoot = path.join(root, "repo");
    for (const directory of [".agents", ".claude", ".codex"])
      writeSkill(
        workspaceRoot,
        [directory, "skills", "review"],
        `---\ndescription: ${directory} review\n---\nReview.`,
      );
    const result = await runScan({ userHome, workspaceRoot });
    expect(result.skills).toHaveLength(1);
    expect((result.skills[0]?.providerVariants?.claudeAgent ?? result.skills[0])?.sourcePath).toBe(
      ".claude/skills/review/SKILL.md",
    );
    expect(result.skills[0]?.providerVariants?.codex?.sourcePath).toBe(
      ".codex/skills/review/SKILL.md",
    );
  });
  it("watches the closest existing ancestor of a new nested user skill root", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    const userHome = path.join(root, "home");
    const workspaceRoot = path.join(root, "repo");
    mkdirSync(path.join(userHome, ".gemini"), { recursive: true });
    const result = await runScan({ userHome, workspaceRoot });
    expect(result.watchPaths).toContain(path.join(userHome, ".gemini"));
  });
  it("parses supported Claude skill frontmatter fields", () => {
    expect(
      parseClaudeSkillDocument({
        commandName: "review",
        documentText: `---
name: Review Helper
description: Review the current diff for correctness.
allowed-tools:
  - Read
  - Grep
paths:
  - src/**
argument-hint: <target>
---
# Review Helper
`,
      }),
    ).toEqual({
      displayName: "Review Helper",
      description: "Review the current diff for correctness.",
      argumentHint: "<target>",
      allowedTools: ["Read", "Grep"],
      paths: ["src/**"],
    });
  });

  it("rejects unsafe skill directory names", () => {
    expect(isSafeProjectSkillDirectoryName("review")).toBe(true);
    expect(isSafeProjectSkillDirectoryName("..")).toBe(false);
    expect(isSafeProjectSkillDirectoryName(".")).toBe(false);
    expect(isSafeProjectSkillDirectoryName("foo/bar")).toBe(false);
    expect(isSafeProjectSkillDirectoryName("foo\\bar")).toBe(false);
  });

  it("falls back to the first markdown paragraph when description frontmatter is missing", () => {
    expect(
      parseClaudeSkillDocument({
        commandName: "review",
        documentText: `---
name: Review Helper
---
# Review Helper

Review the requested changes and summarize correctness risks.

## Notes
Use the existing code patterns.
`,
      }),
    ).toMatchObject({
      displayName: "Review Helper",
      description: "Review the requested changes and summarize correctness risks.",
    });
  });

  it("omits missing SKILL.md folders and warns on reserved and invalid skills", async () => {
    const tempRoot = createTempRoot();
    tempRoots.push(tempRoot);
    const userHome = path.join(tempRoot, "home");
    const workspaceRoot = path.join(tempRoot, "workspace");

    mkdirSync(path.join(userHome, ".claude", "skills", "missing-doc"), { recursive: true });
    writeSkill(
      userHome,
      [".claude", "skills", "plan"],
      `---
description: Should never load.
---
`,
    );
    writeSkill(
      workspaceRoot,
      [".claude", "skills", "broken"],
      `---
description: [unterminated
---
`,
    );

    const result = await runScan({
      userHome,
      workspaceRoot,
    });

    expect(result.skills).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commandName: "plan",
          reason: expect.stringContaining("Reserved command name"),
          scope: "user",
        }),
        expect.objectContaining({
          commandName: "broken",
          reason: expect.stringContaining("Flow sequence"),
          scope: "project",
        }),
      ]),
    );
  });

  it("resolves project-over-user collisions by command name", async () => {
    const tempRoot = createTempRoot();
    tempRoots.push(tempRoot);
    const userHome = path.join(tempRoot, "home");
    const workspaceRoot = path.join(tempRoot, "workspace");

    writeSkill(
      userHome,
      [".claude", "skills", "review"],
      `---
name: User Review
description: User-scoped review helper.
---
`,
    );
    writeSkill(
      workspaceRoot,
      [".claude", "skills", "review"],
      `---
name: Project Review
description: Project-scoped review helper.
---
`,
    );

    const result = await runScan({
      userHome,
      workspaceRoot,
    });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      commandName: "review",
      displayName: "Project Review",
      description: "Project-scoped review helper.",
      scope: "project",
    });
  });

  it("keeps distinct user and project skills when command names differ", async () => {
    const tempRoot = createTempRoot();
    tempRoots.push(tempRoot);
    const userHome = path.join(tempRoot, "home");
    const workspaceRoot = path.join(tempRoot, "workspace");

    writeSkill(
      userHome,
      [".claude", "skills", "research"],
      `---
description: Research a question before implementation.
---
`,
    );
    writeSkill(
      workspaceRoot,
      [".claude", "skills", "implement"],
      `---
description: Implement the approved plan.
---
`,
    );

    const result = await runScan({
      userHome,
      workspaceRoot,
    });

    expect(result.skills.map((skill) => `${skill.scope}:${skill.commandName}`)).toEqual([
      "project:implement",
      "user:research",
    ]);
  });
  it("discovers flat Antigravity skills and rejects oversized documents", async () => {
    const root = createTempRoot();
    tempRoots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const userHome = path.join(root, "home");
    const skills = path.join(workspaceRoot, ".gemini", "skills");
    mkdirSync(skills, { recursive: true });
    writeFileSync(
      path.join(skills, "review.md"),
      "---\ndescription: Review changes\n---\nReview the diff.",
    );
    writeSkill(workspaceRoot, [".agents", "skills", "huge"], "x".repeat(1024 * 1024 + 1));
    const result = await runScan({ userHome, workspaceRoot });
    expect(result.skills.map((skill) => skill.commandName)).toEqual(["review"]);
    expect(result.skills[0]?.sourcePath).toBe(".gemini/skills/review.md");
    expect(result.warnings.some((warning) => warning.reason.includes("1 MiB"))).toBe(true);
  });
});
