import { randomUUID } from "node:crypto";
import type {
  ComputerAccessAnswer,
  ComputerAccessRequested,
  ComputerAuthorization,
  ComputerGrant,
  RememberedComputerConsent,
} from "@t3tools/contracts";
import { appTier, restrictComputerTier, type ComputerPlatform } from "@t3tools/shared/computerApps";
import type { ComputerConsentStore } from "./ComputerConsentStore";

interface Approval {
  profileId: string;
  projectId: string;
  threadId: string;
  generation: string;
  remembered: boolean;
  grant: ComputerGrant;
  sessions: Set<string>;
}

/** Only native consent or main's signed policy store can mint receipts. Persisted
 * policy gets fresh receipts each main lifetime; issue() never persists policy.
 */
export class ComputerGrantAuthority {
  private readonly approvals = new Map<string, Approval>();
  private readonly active = new Map<string, ReadonlyArray<ComputerGrant>>();
  private readonly authorizations = new Map<string, ComputerAuthorization>();
  private readonly rememberedReceipts = new Map<string, string>();
  private readonly revoked = new Map<string, Set<string>>();
  private runApprovalCount = 0;
  constructor(
    private readonly platform: ComputerPlatform,
    private readonly store?: ComputerConsentStore,
  ) {
    if (!store) return;
    for (const profileId of store.profiles()) {
      for (const record of store.list(profileId)) {
        if (record.kind !== "app-access") continue;
        const tier = restrictComputerTier(record.tier, appTier(record.appId, platform));
        if (tier === "blocked" || tier !== record.tier) continue;
        const receipt = randomUUID();
        this.approvals.set(receipt, {
          profileId,
          projectId: record.projectId,
          threadId: "",
          generation: "",
          remembered: true,
          grant: { appId: record.appId, tier, allowTyping: record.allowTyping, receipt },
          sessions: new Set(),
        });
        this.rememberedReceipts.set(
          JSON.stringify([profileId, record.projectId, record.appId]),
          receipt,
        );
      }
    }
  }

  listRemembered(
    profileId: string,
    projectId?: string,
  ): ReadonlyArray<ComputerGrant & { projectId: string }> {
    return [...this.approvals.values()]
      .filter(
        (approval) =>
          approval.remembered &&
          approval.profileId === profileId &&
          (projectId === undefined || approval.projectId === projectId),
      )
      .map((approval) => ({ projectId: approval.projectId, ...approval.grant }));
  }

  /** Removes authority before storage is touched. Callers suspend these authorizations synchronously. */
  revoke(
    profileId: string,
    consent: RememberedComputerConsent,
    threads?: ReadonlySet<string>,
  ): ReadonlyArray<ComputerAuthorization> {
    const affected: ComputerAuthorization[] = [];
    const matchesProject = (projectId: string | undefined) =>
      consent.kind === "full-access-session" || projectId === consent.projectId;
    for (const [receipt, approval] of this.approvals) {
      if (consent.kind !== "app-access") continue;
      if (approval.profileId !== profileId || !matchesProject(approval.projectId)) continue;
      if (approval.grant.appId !== consent.appId) continue;
      this.approvals.delete(receipt);
      this.rememberedReceipts.delete(
        JSON.stringify([profileId, approval.projectId, approval.grant.appId]),
      );
      if (approval.generation !== "") this.runApprovalCount--;
    }
    for (const [key, authorization] of this.authorizations) {
      if (authorization.profileId !== profileId || !matchesProject(authorization.projectId))
        continue;
      if (threads && !threads.has(authorization.threadId)) continue;
      if (
        (consent.kind === "app-access" || consent.kind === "takeover") &&
        !authorization.grants.some((grant) => grant.appId === consent.appId)
      )
        continue;
      const next = {
        ...authorization,
        grantVersion: authorization.grantVersion + 1,
        grants:
          consent.kind === "app-access"
            ? authorization.grants.filter((grant) => grant.appId !== consent.appId)
            : authorization.grants,
      };
      this.authorizations.set(key, next);
      this.active.set(key, next.grants);
      affected.push(next);
    }
    return affected;
  }

  sessionClosed(profileId: string, threadId: string, generation: string): void {
    const key = profileId + "\0" + threadId + "\0" + generation;
    for (const [receipt, approval] of this.approvals) {
      approval.sessions.delete(key);
      if (
        !approval.remembered &&
        approval.profileId === profileId &&
        approval.threadId === threadId &&
        approval.generation === generation
      ) {
        this.approvals.delete(receipt);
        this.runApprovalCount--;
      }
    }
    this.active.delete(key);
    this.revoked.delete(key);
    this.authorizations.delete(key);
  }

  issue(
    profileId: string,
    request: ComputerAccessRequested,
    answer: ComputerAccessAnswer,
  ): ComputerAccessAnswer {
    // Check the whole request before minting anything: failures must not leak partial receipts.
    const required = answer.decisions.filter((decision) => {
      const app = request.apps.find((entry) => entry.appId === decision.appId);
      return (
        decision.allow &&
        app &&
        request.projectId &&
        request.sessionGeneration &&
        restrictComputerTier(app.tier, appTier(app.appId, this.platform)) !== "blocked" &&
        !this.reusable(profileId, request, app, decision)
      );
    }).length;
    if (required > 10_000 - this.runApprovalCount)
      throw new Error("Computer approval limit reached.");
    const decisions = answer.decisions.map((decision) => {
      const app = request.apps.find((entry) => entry.appId === decision.appId);
      if (!decision.allow || !app || !request.projectId || !request.sessionGeneration)
        return { ...decision, allow: false };
      const tier = restrictComputerTier(app.tier, appTier(app.appId, this.platform));
      if (tier === "blocked") return { ...decision, allow: false };
      const reusable = this.reusable(profileId, request, app, decision);
      if (reusable)
        return { ...decision, allowTyping: reusable.allowTyping, receipt: reusable.receipt! };
      const receipt = randomUUID();
      const grant = {
        appId: app.appId,
        tier,
        allowTyping: tier === "click" && decision.allowTyping,
        receipt,
      };
      this.approvals.set(receipt, {
        profileId,
        projectId: request.projectId,
        threadId: request.threadId,
        generation: request.sessionGeneration,
        remembered: decision.remember,
        grant,
        sessions: new Set(),
      });
      this.runApprovalCount++;
      if (decision.remember) {
        const key = JSON.stringify([profileId, request.projectId, app.appId]);
        const previous = this.approvals.get(this.rememberedReceipts.get(key) ?? "");
        if (previous) previous.remembered = false;
        this.rememberedReceipts.set(key, receipt);
      }
      return { ...decision, allowTyping: grant.allowTyping, receipt };
    });
    return { ...answer, decisions };
  }
  sessionRevoked(profileId: string, request: ComputerAccessRequested, receipt: string): boolean {
    return (
      this.revoked
        .get(profileId + "\0" + request.threadId + "\0" + request.sessionGeneration)
        ?.has(receipt) ?? false
    );
  }
  private reusable(
    profileId: string,
    request: ComputerAccessRequested,
    app: ComputerAccessRequested["apps"][number],
    decision: ComputerAccessAnswer["decisions"][number],
  ): ComputerGrant | undefined {
    if (!decision.remember) return undefined;
    const receipt = this.rememberedReceipts.get(
      JSON.stringify([profileId, request.projectId, app.appId]),
    );
    const approval = receipt ? this.approvals.get(receipt) : undefined;
    const session = profileId + "\0" + request.threadId + "\0" + request.sessionGeneration;
    if (receipt && this.revoked.get(session)?.has(receipt)) return undefined;
    const tier = restrictComputerTier(app.tier, appTier(app.appId, this.platform));
    return approval?.remembered &&
      approval.grant.tier === tier &&
      approval.grant.allowTyping === (tier === "click" && decision.allowTyping)
      ? approval.grant
      : undefined;
  }

  remembered(
    profileId: string,
    projectId: string,
    grants: ReadonlyArray<ComputerGrant>,
  ): ReadonlyArray<ComputerGrant> {
    return grants.filter((grant) => {
      const approval = grant.receipt ? this.approvals.get(grant.receipt) : undefined;
      return (
        approval?.remembered &&
        approval.profileId === profileId &&
        approval.projectId === projectId &&
        this.matches(approval, grant)
      );
    });
  }

  forget(profileId: string, projectId: string, appId: string): void {
    this.unremember(profileId, projectId, appId);
    // Revoke by policy key even if a previous failed write already removed it in memory.
    this.store?.revoke(profileId, {
      version: 1,
      kind: "app-access",
      projectId,
      appId,
      tier: "view",
      allowTyping: false,
      policyVersion: 1,
    });
  }
  unremember(profileId: string, projectId: string, appId: string): void {
    this.rememberedReceipts.delete(JSON.stringify([profileId, projectId, appId]));
    for (const [receipt, approval] of this.approvals)
      if (
        approval.profileId === profileId &&
        approval.projectId === projectId &&
        approval.grant.appId === appId
      ) {
        if (approval.generation === "") this.approvals.delete(receipt);
        else approval.remembered = false;
      }
  }

  validate(authorization: ComputerAuthorization): ComputerAuthorization {
    const key = `${authorization.profileId}\0${authorization.threadId}\0${authorization.sessionGeneration}`;
    const revoked = this.revoked.get(key) ?? new Set<string>();
    for (const previous of this.active.get(key) ?? [])
      if (
        previous.receipt &&
        !authorization.grants.some((grant) => grant.receipt === previous.receipt)
      )
        revoked.add(previous.receipt);
    this.revoked.set(key, revoked);
    const grants = authorization.grants.filter((grant) => {
      const approval = grant.receipt ? this.approvals.get(grant.receipt) : undefined;
      const allowed = Boolean(
        approval &&
        !revoked.has(grant.receipt!) &&
        approval.profileId === authorization.profileId &&
        approval.projectId === authorization.projectId &&
        this.matches(approval, grant) &&
        (approval.remembered ||
          approval.sessions.has(key) ||
          (approval.threadId === authorization.threadId &&
            approval.generation === authorization.sessionGeneration)),
      );
      if (allowed) approval!.sessions.add(key);
      return allowed;
    });
    this.active.set(key, grants);
    const validated = { ...authorization, grants };
    this.authorizations.set(key, validated);
    return validated;
  }

  disconnect(profileId: string): void {
    for (const [id, approval] of this.approvals)
      if (approval.profileId === profileId && !approval.remembered) {
        this.approvals.delete(id);
        if (approval.generation !== "") this.runApprovalCount--;
      }
    for (const map of [this.active, this.revoked])
      for (const key of map.keys()) if (key.startsWith(`${profileId}\0`)) map.delete(key);
    for (const key of this.authorizations.keys())
      if (key.startsWith(profileId + "\0")) this.authorizations.delete(key);
  }
  private matches(approval: Approval, grant: ComputerGrant): boolean {
    return (
      approval.grant.appId === grant.appId &&
      approval.grant.tier === grant.tier &&
      approval.grant.allowTyping === grant.allowTyping
    );
  }
}
