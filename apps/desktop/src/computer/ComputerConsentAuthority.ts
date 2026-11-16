import type {
  ComputerAccessAnswer,
  ComputerAccessRequested,
  RememberedComputerConsent,
} from "@t3tools/contracts";
import { appTier, restrictComputerTier, type ComputerPlatform } from "@t3tools/shared/computerApps";
import { INTEGRATION_DISCLOSURES } from "@t3tools/shared/providerIntegrationCertification";
import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";
import {
  alwaysAllowableIntegration,
  type AlwaysAllowableIntegration,
} from "./IntegrationConsentStore";

const quoteUntrusted = (value: string) =>
  JSON.stringify(
    value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 500),
  );

/** Renderer gestures only open a prompt. Only main's native dialog can widen access. */
export class ComputerConsentAuthority {
  private readonly pending = new Set<string>();
  constructor(
    private readonly options: {
      platform: ComputerPlatform;
      request: (profileId: string, answer: ComputerAccessAnswer) => ComputerAccessRequested;
      answer: (
        profileId: string,
        answer: ComputerAccessAnswer,
        policies?: ReadonlyArray<RememberedComputerConsent>,
      ) => void;
      remembered?: boolean;
      cooperative?: (profileId: string) => boolean;
      show: (profileId: string, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
      /**
       * Remembers "always allow" for a profile's Codex Chrome sessions or Claude in Chrome
       * setup, once answered.
       */
      alwaysAllow?: (profileId: string, integration: AlwaysAllowableIntegration) => void;
    },
  ) {}

  async review(profileId: string, offered: ComputerAccessAnswer): Promise<void> {
    const request = this.options.request(profileId, offered);
    const current = () => {
      if (this.options.request(profileId, offered) !== request)
        throw new Error("This request expired or was replaced.");
    };
    const policies: RememberedComputerConsent[] = [];
    const key = `${profileId}\0${offered.backendIncarnation}\0${request.requestId}`;
    if (this.pending.has(key)) throw new Error("This request is already being reviewed.");
    this.pending.add(key);
    let remember = false;
    const rememberable = this.options.alwaysAllow ? alwaysAllowableIntegration(request) : undefined;
    try {
      let answer: ComputerAccessAnswer = {
        requestId: request.requestId,
        backendIncarnation: offered.backendIncarnation,
        decisions: [],
      };
      if (request.kind === "foreground-takeover") {
        const takeover = request.takeover;
        const appName = quoteUntrusted(takeover?.appName ?? takeover?.appId ?? "this app");
        const choice = await this.options.show(profileId, {
          type: "warning",
          title: "F5 computer access",
          message: `Let the agent take the foreground in ${appName}?`,
          detail: `F5 waits until you stop typing and moving the pointer, then brings ${appName} to the front and controls the pointer and keyboard there until the turn ends. ${request.fullAccess && this.options.cooperative?.(profileId) ? "Your input makes the agent wait until you stop; ⌃⌘Esc stops it." : "Your input or ⌃⌘Esc stops it."}\nApp identity: ${quoteUntrusted(takeover?.appId ?? "")}\nAgent’s unverified reason: ${quoteUntrusted(takeover?.reason ?? request.reason)}`,
          buttons: ["Deny", "Allow foreground"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          ...(this.options.remembered && request.fullAccess && request.projectId
            ? {
                checkboxLabel:
                  "Always allow foreground in this app for Full access threads in this project (revoke in Settings)",
                checkboxChecked: false,
              }
            : {}),
        });
        answer = { ...answer, allowForegroundTakeover: choice.response === 1 };
        current();
        if (
          choice.response === 1 &&
          choice.checkboxChecked &&
          this.options.remembered &&
          request.fullAccess &&
          request.projectId &&
          takeover
        )
          policies.push({
            version: 1,
            kind: "takeover",
            projectId: request.projectId,
            appId: takeover.appId,
            policyVersion: 1,
          });
      } else if (request.kind !== "apps") {
        const setup = request.chromeSetup;
        const session = request.kind === "chrome-session" ? request.chromeSession : undefined;
        // Disclosures are F5-authored; the backend chooses only which integration applies.
        const disclosures = setup
          ? setup.provider === "claude"
            ? INTEGRATION_DISCLOSURES["claude-chrome"]
            : []
          : session
            ? INTEGRATION_DISCLOSURES[session.integration]
            : [];
        const choice = await this.options.show(profileId, {
          type: "warning",
          title: "F5 computer access",
          message:
            request.kind === "chrome-setup"
              ? "Allow browser integration setup?"
              : request.kind === "chrome-session"
                ? session?.integration === "codex-computer"
                  ? "Allow Codex Computer Use for this session?"
                  : "Allow Codex to use Chrome for this session?"
                : "Allow session computer actions?",
          detail: setup
            ? `Current browser targets:\n${setup.previousTargets.map(quoteUntrusted).join("\n")}\nNew target:\n${quoteUntrusted(setup.targetPath)}\nThis integration can act on sites you are signed in to.${disclosures.map((line) => `\n• ${line}`).join("")}`
            : session
              ? `This integration can act on sites and apps you are signed in to.${disclosures.map((line) => `\n• ${line}`).join("")}`
              : `Allow this agent session to control apps you separately approve?${request.background ? "\nF5 may keep acting in granted apps while you work elsewhere." : ""}\nAgent’s unverified reason: ${quoteUntrusted(request.reason)}`,
          buttons: ["Deny", "Allow"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          ...(rememberable
            ? {
                checkboxLabel: "Always allow for this profile (revoke in Settings)",
                checkboxChecked: false,
              }
            : this.options.remembered &&
                request.kind === "session-actions" &&
                ((request.fullAccess && request.background) || request.projectId)
              ? {
                  checkboxLabel:
                    request.fullAccess && request.background
                      ? "Don't ask again in Full access threads (this profile; revoke in Settings)"
                      : "Don't ask again for this project",
                  checkboxChecked: false,
                }
              : {}),
        });
        remember = rememberable !== undefined && choice.response === 1 && choice.checkboxChecked;
        if (request.kind === "chrome-setup")
          answer = { ...answer, allowChromeSetup: choice.response === 1 };
        else if (request.kind === "chrome-session")
          answer = { ...answer, allowChromeSession: choice.response === 1 };
        else answer = { ...answer, allowSessionActions: choice.response === 1 };
        current();
        if (
          this.options.remembered &&
          request.kind === "session-actions" &&
          choice.response === 1 &&
          choice.checkboxChecked
        ) {
          if (request.fullAccess && request.background)
            policies.push({ version: 1, kind: "full-access-session", policyVersion: 1 });
          else if (request.projectId)
            policies.push({
              version: 1,
              kind: "session-actions",
              projectId: request.projectId,
              background: request.background === true,
              policyVersion: 1,
            });
        }
      } else {
        const decisions: ComputerAccessAnswer["decisions"][number][] = [];
        for (const app of request.apps) {
          // Revalidate after each prompt: neither a replaced backend nor an expired
          // request can collect more decisions or receive a late approval.
          current();
          const tier = restrictComputerTier(app.tier, appTier(app.appId, this.options.platform));
          if (tier === "blocked") {
            decisions.push({ appId: app.appId, allow: false, allowTyping: false, remember: false });
            continue;
          }
          const choice = await this.options.show(profileId, {
            type: "warning",
            title: "F5 computer access",
            message: `Allow access to ${quoteUntrusted(app.name)}?`,
            detail: `${tier === "view" ? "Viewing only." : tier === "click" ? "Typing here can run commands. Choose typing separately." : "Control includes typing in this app."}${app.warning === "browser" ? "\nThis app can act on sites you are signed in to." : ""}\nApp identity: ${quoteUntrusted(app.appId)}\nAgent’s unverified reason: ${quoteUntrusted(request.reason)}`,
            buttons:
              tier === "click"
                ? ["Deny", "Allow clicks", "Allow clicks and typing"]
                : ["Deny", tier === "view" ? "Allow viewing" : "Allow control and typing"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
            checkboxLabel: this.options.remembered
              ? "Don't ask again for this project"
              : "Remember for this project while F5 is running",
            checkboxChecked: false,
          });
          decisions.push({
            appId: app.appId,
            allow: choice.response > 0 && choice.response < (tier === "click" ? 3 : 2),
            allowTyping: tier === "click" && choice.response === 2,
            remember: choice.response > 0 && choice.checkboxChecked,
          });
          current();
          if (
            this.options.remembered &&
            request.projectId &&
            decisions.at(-1)!.allow &&
            decisions.at(-1)!.remember
          )
            policies.push({
              version: 1,
              kind: "app-access",
              projectId: request.projectId,
              appId: app.appId,
              tier,
              allowTyping: tier === "click" && choice.response === 2,
              policyVersion: 1,
            });
        }
        answer = { ...answer, decisions };
      }
      current();
      if (policies.length) this.options.answer(profileId, answer, policies);
      else this.options.answer(profileId, answer);
    } finally {
      this.pending.delete(key);
    }
    // Stored only once the request it answers was still current and has been answered.
    if (remember && rememberable) this.options.alwaysAllow?.(profileId, rememberable);
  }

  async confirmResume(
    profileId: string,
    threadTitle: string,
    context: { recovery?: boolean } = {},
  ): Promise<boolean> {
    const choice = await this.options.show(profileId, {
      type: "warning",
      title: "Resume F5 computer control?",
      message: `Resume computer control for ${threadTitle}?`,
      detail: context.recovery
        ? "Action outcome is unknown; check the app before resuming. Resuming confirms you checked it; the agent must inspect the app again before acting."
        : "Physical input will pause control again. The agent must take a fresh screenshot before clicking.",
      buttons: ["Cancel", "Resume"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return choice.response === 1;
  }
}
