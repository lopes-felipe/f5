import * as NodePath from "node:path";
import * as fs from "node:fs/promises";
import os from "node:os";
import { buildAccountExecutionEnvironment } from "../../providerProcessEnv.ts";
import { fallbackDefaultProfile } from "../../profiles/ProfileRegistryStore.ts";
import { describe, expect, it, vi } from "vitest";
import {
  antigravityAuthorizationUrl,
  antigravityEnvironment,
  antigravityProfileDirectory,
  linkAntigravityUserSkills,
} from "./AntigravityAcpSupport.ts";
import {
  antigravityApprovalOptions,
  antigravityQuestion,
  antigravityQuestionResponse,
} from "./AntigravityQuestions.ts";
import { acpElicitationDescriptor, acpElicitationResponse } from "./AcpElicitationForm.ts";
import type { RequestPermissionRequest } from "effect-acp/schema";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rmdir: vi.fn(actual.rmdir) };
});

describe("Antigravity profile skills", () => {
  it("links existing global skills, repairs stale links and preserves profile content", async () => {
    await withSkillsProfile(
      async ({ home, userHome, source: configSource, target: configTarget }) => {
        const cliSource = NodePath.join(userHome, ".gemini", "antigravity-cli", "skills");
        const cliTarget = NodePath.join(home, "antigravity-cli", "skills");
        const symlinkType = process.platform === "win32" ? "junction" : "dir";
        await linkAntigravityUserSkills(home, userHome);
        await expect(fs.lstat(configTarget)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.lstat(cliTarget)).rejects.toMatchObject({ code: "ENOENT" });

        await fs.mkdir(NodePath.join(configSource, "review"), { recursive: true });
        await linkAntigravityUserSkills(home, userHome);
        expect(await fs.readlink(configTarget)).toBe(configSource);
        expect((await fs.stat(NodePath.join(configTarget, "review"))).isDirectory()).toBe(true);
        await expect(fs.lstat(cliTarget)).rejects.toMatchObject({ code: "ENOENT" });

        await fs.mkdir(cliTarget, { recursive: true });
        await linkAntigravityUserSkills(home, userHome);
        expect((await fs.lstat(cliTarget)).isDirectory()).toBe(true);
        await fs.mkdir(cliSource, { recursive: true });
        await fs.unlink(configTarget);
        await fs.mkdir(NodePath.join(configTarget, "own-skill"), { recursive: true });
        await linkAntigravityUserSkills(home, userHome);
        expect(await fs.readlink(cliTarget)).toBe(cliSource);
        expect((await fs.stat(NodePath.join(configTarget, "own-skill"))).isDirectory()).toBe(true);

        await fs.unlink(cliTarget);
        await fs.symlink(NodePath.join(home, "missing"), cliTarget, symlinkType);
        await linkAntigravityUserSkills(home, userHome);
        expect(await fs.readlink(cliTarget)).toBe(cliSource);
        await fs.rm(cliSource, { recursive: true });
        await linkAntigravityUserSkills(home, userHome);
        await expect(fs.lstat(cliTarget)).rejects.toMatchObject({ code: "ENOENT" });
        await fs.mkdir(cliTarget, { recursive: true });
        expect((await fs.stat(cliTarget)).isDirectory()).toBe(true);
      },
    );
  });

  async function withSkillsProfile(
    run: (profile: {
      home: string;
      userHome: string;
      source: string;
      target: string;
    }) => Promise<void>,
  ) {
    const temporary = await fs.mkdtemp(NodePath.join(os.tmpdir(), "f5-antigravity-skills-"));
    const home = NodePath.join(temporary, "profile");
    const userHome = NodePath.join(temporary, "user");
    try {
      await run({
        home,
        userHome,
        source: NodePath.join(userHome, ".gemini", "config", "skills"),
        target: NodePath.join(home, "config", "skills"),
      });
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  it.each(["placeholder", "stale link", "removed source"])(
    "allows concurrent preparations with a %s",
    async (kind) => {
      await withSkillsProfile(async ({ home, userHome, source, target }) => {
        await fs.mkdir(source, { recursive: true });
        await fs.writeFile(NodePath.join(source, "review.md"), "keep global skills");
        await fs.mkdir(NodePath.dirname(target), { recursive: true });
        if (kind === "placeholder") {
          await fs.mkdir(target);
        } else {
          await fs.symlink(
            kind === "removed source" ? source : NodePath.join(home, "missing"),
            target,
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        if (kind === "removed source") await fs.rm(source, { recursive: true });

        await expect(
          Promise.all(Array.from({ length: 8 }, () => linkAntigravityUserSkills(home, userHome))),
        ).resolves.toHaveLength(8);
        if (kind !== "removed source") {
          expect(await fs.readFile(NodePath.join(source, "review.md"), "utf8")).toBe(
            "keep global skills",
          );
        }
      });
    },
  );

  it("continues linking the other directory after a filesystem error", async () => {
    await withSkillsProfile(async ({ home, userHome, source }) => {
      await fs.mkdir(NodePath.dirname(NodePath.dirname(source)), { recursive: true });
      await fs.writeFile(NodePath.dirname(source), "not a directory");
      const cliSource = NodePath.join(userHome, ".gemini", "antigravity-cli", "skills");
      const cliTarget = NodePath.join(home, "antigravity-cli", "skills");
      await fs.mkdir(cliSource, { recursive: true });

      await expect(linkAntigravityUserSkills(home, userHome)).resolves.toBeUndefined();
      expect((await fs.lstat(cliTarget)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(cliTarget)).toBe(await fs.realpath(cliSource));
      expect(await fs.readFile(NodePath.dirname(source), "utf8")).toBe("not a directory");
    });
  });

  it("preserves a regular file at the profile target", async () => {
    await withSkillsProfile(async ({ home, userHome, source, target }) => {
      await fs.mkdir(source, { recursive: true });
      await fs.mkdir(NodePath.dirname(target), { recursive: true });
      await fs.writeFile(target, "keep profile content");
      await linkAntigravityUserSkills(home, userHome);
      expect(await fs.readFile(target, "utf8")).toBe("keep profile content");
    });
  });

  it.each(["EBUSY", "EPERM"])("tolerates %s while replacing a placeholder", async (code) => {
    await withSkillsProfile(async ({ home, userHome, source, target }) => {
      await fs.mkdir(source, { recursive: true });
      await fs.mkdir(target, { recursive: true });
      const remove = vi
        .spyOn(fs, "rmdir")
        .mockRejectedValueOnce(Object.assign(new Error("Directory is in use"), { code }));
      try {
        await expect(linkAntigravityUserSkills(home, userHome)).resolves.toBeUndefined();
        expect(remove).toHaveBeenCalledWith(target);
        expect((await fs.lstat(target)).isDirectory()).toBe(true);
      } finally {
        remove.mockRestore();
      }
    });
  });

  it("removes a link when the global skills folder becomes a file", async () => {
    await withSkillsProfile(async ({ home, userHome, source, target }) => {
      await fs.mkdir(source, { recursive: true });
      await linkAntigravityUserSkills(home, userHome);
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
      await fs.rmdir(source);
      await fs.writeFile(source, "not a skills folder");
      await linkAntigravityUserSkills(home, userHome);
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(source, "utf8")).toBe("not a skills folder");
    });
  });
});

describe("Antigravity isolation and native requests", () => {
  it("isolates profile and instance account paths, ignoring inherited credentials", () => {
    expect(antigravityProfileDirectory("/a", "one")).not.toBe(
      antigravityProfileDirectory("/b", "one"),
    );
    expect(antigravityProfileDirectory("/a", "one")).not.toBe(
      antigravityProfileDirectory("/a", "two"),
    );
    const env = antigravityEnvironment(
      {
        PATH: "/bin",
        PYTHONPATH: "/python",
        GOOGLE_APPLICATION_CREDENTIALS: "/tools/credentials.json",
        CLOUDSDK_CONFIG: "/cloud",
        ELECTRON_RUN_AS_NODE: "1",
        HOME: "/home",
        GOOGLE_API_KEY: "secret",
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        gemini_api_key: "secret",
        GEMINI_HOME: "/other",
        BROWSER: "open",
        AGY_ACP_ENABLE_OAUTH: "true",
      },
      "/profile",
      "/harness",
      "helper",
    );
    expect(env).toMatchObject({
      PATH: "/bin",
      GEMINI_HOME: "/profile",
      AGY_ACP_FORCE_FILE_STORAGE: "1",
      ANTIGRAVITY_HARNESS_PATH: "/harness",
      BROWSER: "helper",
    });
    expect(JSON.stringify(env)).not.toContain("secret");
    expect(env.GOOGLE_GENAI_USE_VERTEXAI).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.PYTHONPATH).toBe("/python");
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/tools/credentials.json");
    expect(env.CLOUDSDK_CONFIG).toBe("/cloud");
  });
  it("only exposes Google's OAuth URL with a loopback callback", () => {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("state", "test-state");
    url.searchParams.set("redirect_uri", "http://127.0.0.1:1234/callback");
    expect(antigravityAuthorizationUrl(url.href)).toBe(url.href);
    url.searchParams.set("redirect_uri", "https://evil.invalid/callback");
    expect(antigravityAuthorizationUrl(url.href)).toBeUndefined();
    expect(antigravityAuthorizationUrl("https://evil.invalid/?state=a")).toBeUndefined();
  });
  it("treats interaction permissions as questions and validates the exact selected option", () => {
    const request: RequestPermissionRequest = {
      sessionId: "session",
      toolCall: { toolCallId: "interaction_1", title: "Which environment?" },
      options: [
        { optionId: "prod", name: "Production", kind: "allow_once" },
        { optionId: "dev", name: "Development", kind: "allow_once" },
      ],
    };
    expect(antigravityQuestion(request)).toMatchObject({
      allowCustomAnswer: false,
      options: [{ value: "prod" }, { value: "dev" }],
    });
    expect(antigravityQuestionResponse(request, { interaction_1: "prod" })).toEqual({
      outcome: { outcome: "selected", optionId: "prod" },
    });
    expect(antigravityQuestionResponse(request, { interaction_1: "Production" })).toEqual({
      outcome: { outcome: "selected", optionId: "prod" },
    });
    expect(
      antigravityQuestionResponse(request, { interaction_1: "arbitrary text" }),
    ).toBeUndefined();
    expect(
      antigravityQuestion({ ...request, toolCall: { toolCallId: "ordinary-permission" } }),
    ).toBeUndefined();
  });
  it("shows every elicitation field and never submits its defaults on its own", () => {
    const descriptor = acpElicitationDescriptor({
      mode: "form",
      sessionId: "s",
      message: "Confirm",
      requestedSchema: {
        type: "object",
        properties: {
          name: { type: "string", default: "hidden" },
          remember: { type: "boolean", default: true },
        },
      },
    });
    expect(descriptor.ok).toBe(true);
    if (!descriptor.ok) return;
    expect(descriptor.value.fields?.map((field) => [field.key, field.required])).toEqual([
      ["name", false],
      ["remember", false],
    ]);
    // Defaults are visible suggestions; only submitted content reaches ACP.
    expect(descriptor.value.fields?.[0]?.suggestedValue).toBe("hidden");
    expect(acpElicitationResponse({ action: "accept", content: { remember: false } })).toEqual({
      action: { action: "accept", content: { remember: false } },
    });
    expect(acpElicitationResponse({ action: "accept", content: {} })).toEqual({
      action: { action: "accept", content: {} },
    });
    expect(acpElicitationResponse({ action: "cancel" })).toEqual({
      action: { action: "cancel" },
    });
  });
  it("refuses forms with unsupported constraints instead of silently approving", () => {
    const descriptor = acpElicitationDescriptor({
      mode: "form",
      sessionId: "s",
      message: "Name",
      requestedSchema: { properties: { name: { type: "string", pattern: "unsafe" } } },
    });
    expect(descriptor.ok).toBe(false);
  });
});

it("only offers native permission choices and preserves their security warning", () => {
  const options = antigravityApprovalOptions({
    sessionId: "test",
    toolCall: { toolCallId: "tool" },
    options: [
      {
        optionId: "always",
        name: "Allow",
        kind: "allow_always",
        _meta: { "agy.security.warning": { message: "Be careful with shell commands" } },
      },
    ],
  });
  expect(options).toEqual([
    {
      decision: "acceptForSession",
      label: "Allow for this thread",
      warning: "Be careful with shell commands",
    },
    { decision: "cancel", label: "Cancel" },
  ]);
});

it("keeps provider profile isolation when building the Antigravity child environment", () => {
  const stateDir = "/isolated/profile";
  const env = antigravityEnvironment(
    buildAccountExecutionEnvironment({
      purpose: "provider",
      stateDir,
      profile: { ...fallbackDefaultProfile(stateDir), isDefault: false },
      baseEnv: {
        HOME: "/personal",
        GH_TOKEN: "personal-secret",
        GITHUB_TOKEN: "personal-secret",
        GIT_AUTHOR_EMAIL: "personal@example.com",
      },
    }),
    "/isolated/antigravity",
    "/harness",
    "helper",
  );
  expect(env.HOME).not.toBe("/personal");
  expect(env.GH_CONFIG_DIR).toBe(NodePath.join(stateDir, "github"));
  expect(env.GH_TOKEN).toBeUndefined();
  expect(env.GITHUB_TOKEN).toBeUndefined();
  expect(env.GIT_AUTHOR_EMAIL).toBeUndefined();
});
