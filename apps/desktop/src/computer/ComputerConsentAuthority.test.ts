import { describe, expect, it, vi } from "vitest";
import type { ComputerAccessAnswer, ComputerAccessRequested } from "@t3tools/contracts";
import { ComputerConsentAuthority } from "./ComputerConsentAuthority";
import { claudeTerminalTargets } from "./IntegrationConsentStore";

const request: ComputerAccessRequested = {
  requestId: "r",
  threadId: "t",
  reason: "Edit a document",
  kind: "apps",
  apps: [{ appId: "com.apple.Terminal", name: "Terminal", tier: "click" }],
};
const offered: ComputerAccessAnswer = {
  requestId: "r",
  backendIncarnation: "b",
  decisions: [{ appId: "com.apple.Terminal", allow: true, allowTyping: true, remember: true }],
  allowSessionActions: true,
  allowChromeSetup: true,
};
function make(source = request) {
  const show = vi.fn(async () => ({ response: 0, checkboxChecked: false }));
  const answer = vi.fn();
  const read = vi.fn(() => source);
  const authority = new ComputerConsentAuthority({
    platform: "darwin",
    request: read,
    answer,
    show,
  });
  return { authority, show, answer, read };
}
describe("main-owned computer consent", () => {
  it.each([
    {
      fullAccess: false,
      background: false,
      kind: "session-actions",
      label: "Don't ask again for this project",
    },
    {
      fullAccess: false,
      background: true,
      kind: "session-actions",
      label: "Don't ask again for this project",
    },
    {
      fullAccess: true,
      background: true,
      kind: "full-access-session",
      label: "Don't ask again in Full access threads (this profile; revoke in Settings)",
    },
  ])("remembers exactly the approved session policy: $kind/$background", async (entry) => {
    const current: ComputerAccessRequested = {
      ...request,
      projectId: "project",
      kind: "session-actions",
      apps: [],
      fullAccess: entry.fullAccess,
      background: entry.background,
    };
    const answer = vi.fn();
    const show = vi.fn(async () => ({ response: 1, checkboxChecked: true }));
    const authority = new ComputerConsentAuthority({
      platform: "darwin",
      remembered: true,
      request: () => current,
      answer,
      show,
    });
    await authority.review("profile", offered);
    expect(show).toHaveBeenCalledWith(
      "profile",
      expect.objectContaining({
        checkboxLabel: entry.label,
        checkboxChecked: false,
      }),
    );
    expect(answer).toHaveBeenCalledWith(
      "profile",
      expect.objectContaining({ allowSessionActions: true }),
      [
        entry.kind === "full-access-session"
          ? { version: 1, kind: entry.kind, policyVersion: 1 }
          : {
              version: 1,
              kind: entry.kind,
              projectId: "project",
              background: entry.background,
              policyVersion: 1,
            },
      ],
    );
  });
  it("does not commit policy from a replaced native request", async () => {
    let current: ComputerAccessRequested = { ...request, projectId: "project" };
    const answer = vi.fn();
    const authority = new ComputerConsentAuthority({
      platform: "darwin",
      remembered: true,
      request: () => current,
      answer,
      show: async () => {
        current = { ...current };
        return { response: 2, checkboxChecked: true };
      },
    });
    await expect(authority.review("profile", offered)).rejects.toThrow("replaced");
    expect(answer).not.toHaveBeenCalled();
  });
  it("persists only the app tier and typing chosen in the native dialog", async () => {
    const current: ComputerAccessRequested = { ...request, projectId: "project" };
    const answer = vi.fn();
    const authority = new ComputerConsentAuthority({
      platform: "darwin",
      remembered: true,
      request: () => current,
      answer,
      show: async () => ({ response: 1, checkboxChecked: true }),
    });
    await authority.review("profile", offered);
    expect(answer).toHaveBeenCalledWith(
      "profile",
      expect.objectContaining({
        decisions: [
          { appId: "com.apple.Terminal", allow: true, allowTyping: false, remember: true },
        ],
      }),
      [
        {
          version: 1,
          kind: "app-access",
          projectId: "project",
          appId: "com.apple.Terminal",
          tier: "click",
          allowTyping: false,
          policyVersion: 1,
        },
      ],
    );
  });
  it.each(["view", "full"] as const)(
    "makes %s rights explicit without allowing renderer typing choices",
    async (tier) => {
      const h = make({ ...request, apps: [{ appId: "org.example.App", name: "Example", tier }] });
      h.show.mockResolvedValue({ response: 1, checkboxChecked: false });
      await h.authority.review("profile", offered);
      expect(h.show).toHaveBeenCalledWith(
        "profile",
        expect.objectContaining({
          buttons: ["Deny", tier === "view" ? "Allow viewing" : "Allow control and typing"],
          defaultId: 0,
        }),
      );
      expect(h.answer.mock.calls[0]![1].decisions[0]).toMatchObject({
        allow: true,
        allowTyping: false,
        remember: false,
      });
    },
  );
  it("ignores every renderer allowance even after a trusted unrelated click", async () => {
    const h = make();
    await h.authority.review("profile", offered);
    expect(h.answer).toHaveBeenCalledWith("profile", {
      requestId: "r",
      backendIncarnation: "b",
      decisions: [
        { appId: "com.apple.Terminal", allow: false, allowTyping: false, remember: false },
      ],
    });
    expect(h.show).toHaveBeenCalledWith(
      "profile",
      expect.objectContaining({
        buttons: ["Deny", "Allow clicks", "Allow clicks and typing"],
        defaultId: 0,
        cancelId: 0,
        checkboxChecked: false,
      }),
    );
  });
  it("typing and remembering follow only the native dialog choices", async () => {
    const h = make();
    h.show.mockResolvedValue({ response: 2, checkboxChecked: true });
    await h.authority.review("profile", { ...offered, decisions: [] });
    expect(h.answer.mock.calls[0]![1].decisions).toEqual([
      { appId: "com.apple.Terminal", allow: true, allowTyping: true, remember: true },
    ]);
    h.show.mockResolvedValue({ response: 1, checkboxChecked: false });
    await h.authority.review("profile", offered);
    expect(h.answer.mock.calls[1]![1].decisions[0]).toMatchObject({
      allow: true,
      allowTyping: false,
      remember: false,
    });
  });
  it("does not prompt for or allow a protected app advertised as full", async () => {
    const h = make({
      ...request,
      apps: [{ appId: "com.apple.systempreferences", name: "Settings", tier: "full" }],
    });
    await h.authority.review("profile", offered);
    expect(h.show).not.toHaveBeenCalled();
    expect(h.answer.mock.calls[0]![1].decisions[0]?.allow).toBe(false);
  });
  it("rejects expiry while the dialog is open and prevents duplicate prompts", async () => {
    const h = make();
    let finish: (value: { response: number; checkboxChecked: boolean }) => void = () => {};
    const prompt = new Promise<{ response: number; checkboxChecked: boolean }>((resolve) => {
      finish = resolve;
    });
    h.show.mockReturnValue(prompt);
    const pending = h.authority.review("profile", offered);
    await expect(h.authority.review("profile", offered)).rejects.toThrow("already being reviewed");
    h.read.mockImplementation(() => {
      throw new Error("expired");
    });
    finish({ response: 2, checkboxChecked: true });
    await expect(pending).rejects.toThrow("expired");
    expect(h.answer).not.toHaveBeenCalled();
  });
  it.each(["session-actions", "chrome-setup"] as const)(
    "renderer cannot approve %s",
    async (kind) => {
      const h = make({ ...request, kind, apps: [] });
      await h.authority.review("profile", offered);
      expect(h.answer.mock.calls[0]![1]).toMatchObject(
        kind === "chrome-setup" ? { allowChromeSetup: false } : { allowSessionActions: false },
      );
      expect(h.answer.mock.calls[0]![1].decisions).toEqual([]);
    },
  );
  it("remembers always-allow for a Chrome session only from the native dialog's checkbox", async () => {
    const session: ComputerAccessRequested = {
      ...request,
      kind: "chrome-session",
      apps: [],
      chromeSession: { integration: "codex-chrome" },
    };
    const alwaysAllow = vi.fn();
    const show = vi.fn(async () => ({ response: 1, checkboxChecked: false }));
    const answer = vi.fn();
    const authority = new ComputerConsentAuthority({
      platform: "darwin",
      request: () => session,
      answer,
      show,
      alwaysAllow,
    });
    await authority.review("profile", { ...offered, allowChromeSession: true });
    expect(show).toHaveBeenLastCalledWith(
      "profile",
      expect.objectContaining({
        checkboxLabel: "Always allow for this profile (revoke in Settings)",
        checkboxChecked: false,
      }),
    );
    expect(alwaysAllow).not.toHaveBeenCalled();
    // Denied with the box ticked: nothing is remembered.
    show.mockResolvedValueOnce({ response: 0, checkboxChecked: true });
    await authority.review("profile", offered);
    expect(alwaysAllow).not.toHaveBeenCalled();
    expect(answer.mock.calls.at(-1)![1]).toMatchObject({ allowChromeSession: false });
    show.mockResolvedValueOnce({ response: 1, checkboxChecked: true });
    await authority.review("profile", offered);
    expect(alwaysAllow).toHaveBeenCalledWith("profile", "codex-chrome");
    expect(answer.mock.calls.at(-1)![1]).toMatchObject({ allowChromeSession: true });
  });
  it("remembers always-allow for Claude taking over the terminal, never for other setups", async () => {
    const terminal = claudeTerminalTargets()[0]!;
    const claudeSetup = (
      provider: "claude" | "codex",
      previousTargets = [terminal],
    ): ComputerAccessRequested => ({
      ...request,
      kind: "chrome-setup",
      apps: [],
      chromeSetup: { provider, previousTargets, targetPath: "/f5/wrapper" },
    });
    let current = claudeSetup("claude");
    const alwaysAllow = vi.fn();
    const show = vi.fn(async (_profileId: string, _options: object) => ({
      response: 1,
      checkboxChecked: true,
    }));
    const answer = vi.fn();
    const authority = new ComputerConsentAuthority({
      platform: "darwin",
      request: () => current,
      answer,
      show,
      alwaysAllow,
    });
    await authority.review("profile", offered);
    expect(show.mock.calls[0]![1]).toMatchObject({
      message: "Allow browser integration setup?",
      checkboxLabel: "Always allow for this profile (revoke in Settings)",
    });
    expect(answer.mock.calls.at(-1)![1]).toMatchObject({ allowChromeSetup: true });
    expect(alwaysAllow).toHaveBeenCalledWith("profile", "claude-chrome");
    current = claudeSetup("codex");
    await authority.review("profile", offered);
    expect(show.mock.calls[1]![1]).not.toHaveProperty("checkboxLabel");
    // Another F5 profile's wrapper, alone or next to the terminal's, always asks.
    for (const targets of [["/other-profile/claude/chrome/chrome-native-host"], [terminal, "/x"]]) {
      current = claudeSetup("claude", targets);
      await authority.review("profile", offered);
      expect(show.mock.calls.at(-1)![1]).not.toHaveProperty("checkboxLabel");
    }
    expect(alwaysAllow).toHaveBeenCalledOnce();
  });
  it("remembers nothing when the request expires while the dialog is open", async () => {
    const session: ComputerAccessRequested = {
      ...request,
      kind: "chrome-session",
      apps: [],
      chromeSession: { integration: "codex-chrome" },
    };
    const alwaysAllow = vi.fn();
    const answer = vi.fn();
    let expired = false;
    const authority = new ComputerConsentAuthority({
      platform: "darwin",
      request: () => {
        if (expired) throw new Error("This request expired or belongs to another backend.");
        return session;
      },
      answer,
      show: vi.fn(async () => {
        expired = true;
        return { response: 1, checkboxChecked: true };
      }),
      alwaysAllow,
    });
    await expect(authority.review("profile", offered)).rejects.toThrow("expired");
    expect(answer).not.toHaveBeenCalled();
    expect(alwaysAllow).not.toHaveBeenCalled();
  });
  it("offers no always-allow for Codex Computer Use sessions", async () => {
    const alwaysAllow = vi.fn();
    const show = vi.fn(async (_profileId: string, _options: object) => ({
      response: 1,
      checkboxChecked: true,
    }));
    const current: ComputerAccessRequested = {
      ...request,
      kind: "chrome-session",
      apps: [],
      chromeSession: { integration: "codex-computer" },
    };
    const authority = new ComputerConsentAuthority({
      platform: "darwin",
      request: () => current,
      answer: vi.fn(),
      show,
      alwaysAllow,
    });
    await authority.review("profile", offered);
    expect(show.mock.calls[0]![1]).not.toHaveProperty("checkboxLabel");
    expect(alwaysAllow).not.toHaveBeenCalled();
  });
  it("offers no always-allow for other kinds of request", async () => {
    const alwaysAllow = vi.fn();
    const show = vi.fn(async (_profileId: string, _options: object) => ({
      response: 1,
      checkboxChecked: true,
    }));
    const authority = new ComputerConsentAuthority({
      platform: "darwin",
      request: vi.fn().mockReturnValue({ ...request, kind: "session-actions", apps: [] }),
      answer: vi.fn(),
      show,
      alwaysAllow,
    });
    await authority.review("profile", offered);
    expect(show.mock.calls[0]![1]).not.toHaveProperty("checkboxLabel");
    expect(alwaysAllow).not.toHaveBeenCalled();
  });
  it("requires independent native confirmation for Resume", async () => {
    const h = make();
    expect(await h.authority.confirmResume("profile", "Trusted thread")).toBe(false);
    h.show.mockResolvedValue({ response: 1, checkboxChecked: false });
    expect(await h.authority.confirmResume("profile", "Trusted thread")).toBe(true);
    expect(h.show).toHaveBeenLastCalledWith(
      "profile",
      expect.objectContaining({
        defaultId: 0,
        cancelId: 0,
        message: "Resume computer control for Trusted thread?",
      }),
    );
  });
});
