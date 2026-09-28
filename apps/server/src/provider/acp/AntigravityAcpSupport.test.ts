import { buildAccountExecutionEnvironment } from "../../providerProcessEnv.ts";
import { fallbackDefaultProfile } from "../../profiles/ProfileRegistryStore.ts";
import { describe, expect, it } from "vitest";
import {
  antigravityAuthorizationUrl,
  antigravityEnvironment,
  antigravityProfileDirectory,
} from "./AntigravityAcpSupport.ts";
import {
  antigravityApprovalOptions,
  antigravityQuestion,
  antigravityQuestionResponse,
} from "./AntigravityQuestions.ts";
import { acpElicitationForm } from "./AcpElicitationForm.ts";
import type { RequestPermissionRequest } from "effect-acp/schema";

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
    expect(antigravityQuestion(request)?.options).toHaveLength(2);
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
  it("shows every elicitation field and never submits its hidden defaults", () => {
    const form = acpElicitationForm({
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
    expect(form?.questions.map((question) => question.id)).toEqual(["name", "remember"]);
    expect(form?.respond({ remember: "No" })).toEqual({
      action: { action: "accept", content: { remember: false } },
    });
    expect(form?.questions.every((question) => question.optional)).toBe(true);
    expect(form?.respond({ name: "", remember: "" })).toEqual({
      action: { action: "accept", content: {} },
    });
    expect(form?.respond({})).toEqual({ action: { action: "cancel" } });
  });
  it("refuses forms with unsupported constraints instead of silently approving", () => {
    expect(
      acpElicitationForm({
        mode: "form",
        sessionId: "s",
        message: "Name",
        requestedSchema: { properties: { name: { type: "string", pattern: "unsafe" } } },
      }),
    ).toBeUndefined();
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
  expect(env.GH_CONFIG_DIR).toContain(stateDir);
  expect(env.GH_TOKEN).toBeUndefined();
  expect(env.GITHUB_TOKEN).toBeUndefined();
  expect(env.GIT_AUTHOR_EMAIL).toBeUndefined();
});
