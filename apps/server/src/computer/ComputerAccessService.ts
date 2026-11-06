import { COMPUTER_TAKEOVER_CONSENT_TIMEOUT_MS } from "@t3tools/contracts";
import { randomUUID } from "node:crypto";
import type {
  ComputerAccessAnswer,
  ComputerAccessRequested,
  ComputerApp,
  ComputerGrant,
  RememberedComputerGrant,
} from "@t3tools/contracts";
import {
  appTier,
  restrictComputerTier,
  grantAllows,
  type ComputerPlatform,
} from "@t3tools/shared/computerApps";
import { ComputerControlError } from "@t3tools/shared/computerControl";

interface Binding {
  projectId: string;
  generation: string;
  version: number;
  overrides: Map<string, ComputerGrant | null>;
  actionsApproved: boolean;
  /** Electron minted a background receipt for this provider session. */
  backgroundApproved: boolean;
}
export interface ComputerTakeoverConsent {
  readonly requestId: string;
  readonly appId: string;
  readonly appName?: string;
  readonly turnId: string;
}
export type { RememberedComputerGrant } from "@t3tools/contracts";
export interface RememberedGrantSource {
  load: (projectId?: string) => Promise<ReadonlyArray<RememberedComputerGrant>>;
  forget: (projectId: string, appId: string) => Promise<void>;
}
interface Pending {
  request: ComputerAccessRequested;
  generation: string;
  turnId: string;
  expiresAtMs: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: ComputerAccessAnswer | null) => void;
}
export interface ComputerAccessStorage {
  load: () => Promise<ReadonlyArray<RememberedComputerGrant>>;
  save: (grants: ReadonlyArray<RememberedComputerGrant>) => Promise<void>;
}
/** Main-owned policy for capable desktops; legacy storage never creates native receipts. */
export class ComputerAccessService {
  private remembered: ReadonlyArray<RememberedComputerGrant> = [];
  private readonly bindings = new Map<string, Binding>();
  private readonly pending = new Map<string, Pending>();
  private readonly deniedThisTurn = new Set<string>();
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly options: {
      platform: ComputerPlatform;
      backendIncarnation: string;
      storage: ComputerAccessStorage;
      remembered?: RememberedGrantSource;
      mainOwned?: () => boolean;
      request: (request: ComputerAccessRequested, expiresAtMs: number) => void;
      settled: (
        requestId: string,
        threadId: string,
        allowed: boolean,
        persistence?: Pick<ComputerAccessAnswer, "persistence" | "persistenceReason">,
      ) => void;
      changed: (threadId: string) => void;
      timeoutMs?: number;
      forgotten?: (projectId: string, appId: string) => void | Promise<void>;
    },
  ) {}
  async initialize(): Promise<void> {
    const mainOwned = this.options.mainOwned?.() === true;
    let loaded: ReadonlyArray<RememberedComputerGrant>;
    try {
      loaded = mainOwned
        ? await this.options.remembered!.load()
        : await this.options.storage.load();
    } catch (error) {
      if (mainOwned) return;
      throw error;
    }
    this.remembered = this.normalize(loaded);
  }
  private normalize(
    loaded: ReadonlyArray<RememberedComputerGrant>,
  ): ReadonlyArray<RememberedComputerGrant> {
    return loaded
      .filter((grant) => grant.appId && grant.projectId && grant.tier !== "blocked")
      .map((grant) => ({
        ...grant,
        appId: this.options.platform === "win32" ? grant.appId.toLowerCase() : grant.appId,
        tier: restrictComputerTier(grant.tier, appTier(grant.appId, this.options.platform)),
        allowTyping:
          restrictComputerTier(grant.tier, appTier(grant.appId, this.options.platform)) ===
            "click" && grant.allowTyping,
      }));
  }
  refreshRemembered(projectId?: string): Promise<void> {
    const task = async () => {
      if (!this.options.mainOwned?.() || !this.options.remembered) return;
      let loaded: ReadonlyArray<RememberedComputerGrant>;
      try {
        loaded = await this.options.remembered.load(projectId);
      } catch {
        console.warn("Remembered computer consent refresh failed; retaining current grants.");
        return;
      }
      loaded = this.normalize(loaded);
      const previous = this.remembered;
      this.remembered =
        projectId === undefined
          ? loaded
          : [...previous.filter((grant) => grant.projectId !== projectId), ...loaded];
      for (const [threadId, binding] of this.bindings) {
        if (projectId !== undefined && projectId !== binding.projectId) continue;
        for (const grant of previous)
          if (
            grant.projectId === binding.projectId &&
            !this.remembered.some(
              (next) => next.projectId === grant.projectId && next.appId === grant.appId,
            )
          )
            binding.overrides.set(grant.appId, null);
        // Main is authoritative after a remembered-policy change, including a replacement
        // receipt or an approval added by a sibling session.
        for (const grant of loaded)
          if (
            grant.projectId === binding.projectId &&
            binding.overrides.get(grant.appId) !== null
          ) {
            const prior = previous.find(
              (old) => old.projectId === grant.projectId && old.appId === grant.appId,
            );
            if (!prior || prior.receipt !== grant.receipt) binding.overrides.delete(grant.appId);
          }
        ++binding.version;
        this.options.changed(threadId);
      }
    };
    const result = this.writes.then(task);
    this.writes = result.catch(() => undefined);
    return result;
  }
  revokeSessionApproval(threadId: string): void {
    const binding = this.bindings.get(threadId);
    if (!binding) return;
    binding.actionsApproved = false;
    binding.backgroundApproved = false;
    ++binding.version;
    this.options.changed(threadId);
  }
  bind(threadId: string, projectId: string, generation: string): void {
    if (this.bindings.get(threadId)?.generation === generation) return;
    this.clearSession(threadId);
    this.bindings.set(threadId, {
      projectId,
      generation,
      version: 1,
      overrides: new Map(),
      actionsApproved: false,
      backgroundApproved: false,
    });
  }
  backgroundApproved(threadId: string): boolean {
    const binding = this.bindings.get(threadId);
    return !!binding && binding.actionsApproved && binding.backgroundApproved;
  }
  /** Electron binds the session receipt to the policy revision; a new revision needs a new one. */
  revokeBackgroundApproval(threadId: string): void {
    const binding = this.bindings.get(threadId);
    if (!binding?.backgroundApproved) return;
    binding.backgroundApproved = false;
    ++binding.version;
    this.options.changed(threadId);
  }
  /**
   * Native foreground-takeover consent. Never changes grants; resolves true only when the user
   * allowed it in Electron's dialog. The request id is chosen by the caller so Electron can
   * correlate it with the separately sent takeover acquisition.
   */
  requestTakeover(
    threadId: string,
    takeover: ComputerTakeoverConsent,
    reason: string,
    options: { fullAccess?: boolean } = {},
  ): Promise<boolean> {
    const binding = this.bindings.get(threadId);
    if (!binding) throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    if (
      [...this.pending.values()].some(
        (entry) =>
          entry.request.threadId === threadId && entry.request.kind === "foreground-takeover",
      )
    )
      throw new ComputerControlError({ _tag: "Busy", holder: "same-profile" });
    const request: ComputerAccessRequested = {
      requestId: takeover.requestId,
      projectId: binding.projectId,
      sessionGeneration: binding.generation,
      threadId,
      reason: reason.slice(0, 500),
      kind: "foreground-takeover",
      ...(options.fullAccess ? { fullAccess: true } : {}),
      takeover: {
        appId: takeover.appId,
        ...(takeover.appName ? { appName: takeover.appName.slice(0, 200) } : {}),
        threadId,
        turnId: takeover.turnId,
        reason: reason.slice(0, 500),
      },
      apps: [],
    };
    return new Promise((resolve) => {
      // Longer than Electron's 300 s takeover consent timer: Electron decides, so an Allow
      // clicked near its deadline is never denied here first.
      const timer = setTimeout(
        () => this.deny(request.requestId),
        this.options.timeoutMs ?? 310_000,
      );
      this.pending.set(request.requestId, {
        request,
        generation: binding.generation,
        turnId: takeover.turnId,
        expiresAtMs: Date.now() + COMPUTER_TAKEOVER_CONSENT_TIMEOUT_MS,
        timer,
        resolve: (answer) => resolve(answer?.allowForegroundTakeover === true),
      });
      this.options.request(request, this.pending.get(request.requestId)!.expiresAtMs);
    });
  }
  cancelRequest(requestId: string): void {
    this.deny(requestId);
  }
  projectId(threadId: string): string | undefined {
    return this.bindings.get(threadId)?.projectId;
  }
  version(threadId: string): number {
    return this.bindings.get(threadId)?.version ?? 0;
  }
  actionsApproved(threadId: string): boolean {
    return this.bindings.get(threadId)?.actionsApproved ?? false;
  }
  pendingRequests(): ReadonlyArray<ComputerAccessRequested & { expiresAtMs: number }> {
    return [...this.pending.values()].map((entry) => ({
      ...entry.request,
      expiresAtMs: entry.expiresAtMs,
    }));
  }
  grants(threadId: string): ReadonlyArray<ComputerGrant> {
    const binding = this.bindings.get(threadId);
    if (!binding) return [];
    const grants = new Map(
      this.remembered
        .filter((grant) => grant.projectId === binding.projectId)
        .map((grant) => [
          grant.appId,
          {
            appId: grant.appId,
            tier: grant.tier,
            allowTyping: grant.allowTyping,
            ...(grant.receipt ? { receipt: grant.receipt } : {}),
          },
        ]),
    );
    for (const [appId, grant] of binding.overrides) {
      if (grant) grants.set(appId, grant);
      else grants.delete(appId);
    }
    return [...grants.values()].filter(
      (grant) => appTier(grant.appId, this.options.platform) !== "blocked",
    );
  }
  require(threadId: string, appId: string, needed: "view" | "click" | "type"): void {
    const grant = this.grants(threadId).find((entry) => entry.appId === appId);
    if (!grant || !grantAllows(grant.tier, grant.allowTyping, needed))
      throw new ComputerControlError({ _tag: "NotGranted", needed });
  }
  async requestAccess(
    threadId: string,
    turnId: string,
    apps: ReadonlyArray<ComputerApp>,
    reason: string,
    options: {
      kind?: "apps" | "session-actions";
      typing?: boolean;
      background?: boolean;
      fullAccess?: boolean;
    } = {},
  ): Promise<ComputerAccessAnswer | null> {
    const { kind = "apps", typing = false, background = false, fullAccess = false } = options;
    const binding = this.bindings.get(threadId);
    if (!binding) throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    const candidates = apps
      .filter(
        (app) => app.tier !== "blocked" && appTier(app.appId, this.options.platform) !== "blocked",
      )
      .filter(
        (app) =>
          !this.grants(threadId).some(
            (grant) =>
              grant.appId === app.appId &&
              grant.tier ===
                restrictComputerTier(app.tier, appTier(app.appId, this.options.platform)) &&
              (!typing || grant.tier !== "click" || grant.allowTyping),
          ),
      )
      .filter(
        (app) =>
          !this.deniedThisTurn.has(`${threadId}\0${turnId}\0${app.appId}`) &&
          (!typing || !this.deniedThisTurn.has(`${threadId}\0${turnId}\0${app.appId}\0typing`)),
      );
    if (kind === "apps" && !candidates.length) return null;
    if (
      kind === "session-actions" &&
      this.deniedThisTurn.has(`${threadId}\0${turnId}\0session-actions`)
    )
      return null;
    const existing = [...this.pending.values()].find(
      (entry) =>
        entry.request.threadId === threadId &&
        entry.turnId === turnId &&
        entry.request.kind === kind,
    );
    if (existing) throw new ComputerControlError({ _tag: "Busy", holder: "same-profile" });
    const request: ComputerAccessRequested = {
      requestId: randomUUID(),
      projectId: binding.projectId,
      sessionGeneration: binding.generation,
      threadId,
      reason: reason.slice(0, 500),
      kind,
      ...(typing ? { typingRequested: true } : {}),
      ...(background && kind === "session-actions" ? { background: true } : {}),
      ...(fullAccess && background && kind === "session-actions" ? { fullAccess: true } : {}),
      apps: candidates.slice(0, 10).map((app) => ({
        appId: app.appId,
        name: app.name,
        tier: restrictComputerTier(app.tier, appTier(app.appId, this.options.platform)),
        ...(app.warning ? { warning: app.warning } : {}),
      })),
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.deny(request.requestId);
      }, this.options.timeoutMs ?? 300_000);
      this.pending.set(request.requestId, {
        request,
        generation: binding.generation,
        turnId,
        expiresAtMs: Date.now() + (this.options.timeoutMs ?? 300_000),
        timer,
        resolve,
      });
      this.options.request(request, this.pending.get(request.requestId)!.expiresAtMs);
    });
  }
  /** Only DesktopComputerHost's listener calls this method. No WebSocket answer method exists. */
  answerFromHost(answer: ComputerAccessAnswer): Promise<void> {
    const task = async () => {
      const pending = this.pending.get(answer.requestId);
      if (!pending || answer.backendIncarnation !== this.options.backendIncarnation)
        throw new Error("This request expired.");
      const binding = this.bindings.get(pending.request.threadId);
      if (!binding || binding.generation !== pending.generation) {
        this.deny(answer.requestId);
        throw new Error("This session ended.");
      }
      if (pending.request.kind === "foreground-takeover") {
        // Consent only; Electron arms the takeover itself. Grants never change here.
        this.pending.delete(answer.requestId);
        clearTimeout(pending.timer);
        pending.resolve(answer);
        this.options.settled(
          answer.requestId,
          pending.request.threadId,
          answer.allowForegroundTakeover === true,
          answer,
        );
        return;
      }
      const approvalVersion = binding.version;
      const decisions = pending.request.apps.map((app) => {
        const decision = answer.decisions.find((entry) => entry.appId === app.appId);
        return {
          appId: app.appId,
          ...(decision?.receipt ? { receipt: decision.receipt } : {}),
          allow: app.tier !== "blocked" && decision?.allow === true,
          allowTyping: app.tier === "click" && decision?.allowTyping === true,
          remember: decision?.remember === true,
        };
      });
      const next = [...this.remembered];
      for (const decision of decisions)
        if (decision.allow && decision.remember) {
          const app = pending.request.apps.find((entry) => entry.appId === decision.appId)!;
          const index = next.findIndex(
            (grant) => grant.projectId === binding.projectId && grant.appId === decision.appId,
          );
          if (index >= 0) next.splice(index, 1);
          next.push({
            projectId: binding.projectId,
            appId: app.appId,
            tier: app.tier,
            allowTyping: decision.allowTyping,
            ...(decision.receipt ? { receipt: decision.receipt } : {}),
            ...(answer.persistence ? { persistence: answer.persistence } : {}),
            ...(answer.persistenceReason ? { persistenceReason: answer.persistenceReason } : {}),
          });
        }
      const rememberChanged = decisions.some((decision) => decision.allow && decision.remember);
      if (rememberChanged && !this.options.mainOwned?.()) {
        try {
          await this.options.storage.save(next);
        } catch {
          this.deny(answer.requestId);
          throw new Error(
            "Computer access was denied because the remembered grant could not be saved.",
          );
        }
      }
      // A turn can end while storage is being written. Never revive its session grants.
      if (
        this.pending.get(answer.requestId) !== pending ||
        this.bindings.get(pending.request.threadId) !== binding ||
        binding.version !== approvalVersion
      ) {
        try {
          if (rememberChanged && !this.options.mainOwned?.())
            await this.options.storage.save(this.remembered);
        } finally {
          this.deny(answer.requestId);
        }
        return;
      }
      this.remembered = next;
      if (rememberChanged)
        for (const [threadId, other] of this.bindings)
          if (other !== binding && other.projectId === binding.projectId) {
            ++other.version;
            this.options.changed(threadId);
          }
      for (const decision of decisions) {
        if (pending.request.typingRequested && !decision.allowTyping)
          this.deniedThisTurn.add(
            `${pending.request.threadId}\0${pending.turnId}\0${decision.appId}\0typing`,
          );
        const app = pending.request.apps.find((entry) => entry.appId === decision.appId)!;
        // Declining a typing upgrade never revokes an existing viewing/click grant.
        if (pending.request.typingRequested && !decision.allow) continue;
        binding.overrides.set(
          app.appId,
          decision.allow
            ? {
                appId: app.appId,
                tier: app.tier,
                allowTyping: decision.allowTyping,
                ...(decision.receipt ? { receipt: decision.receipt } : {}),
              }
            : null,
        );
        if (!decision.allow)
          this.deniedThisTurn.add(`${pending.request.threadId}\0${pending.turnId}\0${app.appId}`);
      }
      if (pending.request.kind === "session-actions") {
        binding.actionsApproved = answer.allowSessionActions === true;
        // Only Electron can mint the receipt; a missing one keeps background closed.
        if (pending.request.background)
          binding.backgroundApproved = binding.actionsApproved && !!answer.sessionReceipt;
        if (!binding.actionsApproved)
          this.deniedThisTurn.add(
            `${pending.request.threadId}\0${pending.turnId}\0session-actions`,
          );
      }
      ++binding.version;
      this.options.changed(pending.request.threadId);
      this.pending.delete(answer.requestId);
      clearTimeout(pending.timer);
      pending.resolve({ ...answer, decisions });
      this.options.settled(
        answer.requestId,
        pending.request.threadId,
        pending.request.kind === "session-actions"
          ? binding.actionsApproved
          : decisions.some((decision) => decision.allow),
        answer,
      );
    };
    const result = this.writes.then(task);
    this.writes = result.catch(() => undefined);
    return result;
  }
  private deny(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    for (const app of pending.request.apps)
      this.deniedThisTurn.add(
        `${pending.request.threadId}\0${pending.turnId}\0${app.appId}${pending.request.typingRequested ? "\0typing" : ""}`,
      );
    if (pending.request.kind === "session-actions")
      this.deniedThisTurn.add(`${pending.request.threadId}\0${pending.turnId}\0session-actions`);
    pending.resolve(null);
    this.options.settled(requestId, pending.request.threadId, false);
  }
  revoke(threadId: string, appId: string): void {
    if (this.options.platform === "win32") appId = appId.toLowerCase();
    const binding = this.bindings.get(threadId);
    if (!binding) return;
    for (const [id, pending] of this.pending)
      if (
        pending.request.threadId === threadId &&
        pending.request.apps.some((app) => app.appId === appId)
      )
        this.deny(id);
    binding.overrides.set(appId, null);
    ++binding.version;
    this.options.changed(threadId);
  }
  policyChanged(threadId: string): void {
    const binding = this.bindings.get(threadId);
    if (!binding) return;
    for (const grant of this.grants(threadId)) binding.overrides.set(grant.appId, null);
    binding.actionsApproved = false;
    binding.backgroundApproved = false;
    ++binding.version;
    this.options.changed(threadId);
    for (const [id, pending] of this.pending)
      if (pending.request.threadId === threadId) this.deny(id);
  }
  listRemembered(projectId: string): ReadonlyArray<RememberedComputerGrant> {
    return this.remembered.filter((grant) => grant.projectId === projectId);
  }
  forgetRemembered(projectId: string, appId: string): Promise<void> {
    if (this.options.platform === "win32") appId = appId.toLowerCase();
    const result = this.writes.then(async () => {
      const next = this.remembered.filter(
        (grant) => grant.projectId !== projectId || grant.appId !== appId,
      );
      if (this.options.mainOwned?.()) await this.options.remembered!.forget(projectId, appId);
      else await this.options.forgotten?.(projectId, appId);
      this.remembered = next;
      for (const [threadId, binding] of this.bindings)
        if (binding.projectId === projectId) {
          ++binding.version;
          this.options.changed(threadId);
        }
      if (!this.options.mainOwned?.()) await this.options.storage.save(next);
    });
    this.writes = result.catch(() => undefined);
    return result;
  }
  endTurn(threadId: string, turnId: string): void {
    for (const [id, pending] of this.pending)
      if (pending.request.threadId === threadId && pending.turnId === turnId) this.deny(id);
    for (const key of this.deniedThisTurn)
      if (key.startsWith(`${threadId}\0${turnId}\0`)) this.deniedThisTurn.delete(key);
  }
  clearSession(threadId: string, generation?: string): void {
    if (generation && this.bindings.get(threadId)?.generation !== generation) return;
    for (const [id, pending] of this.pending)
      if (pending.request.threadId === threadId) this.deny(id);
    this.bindings.delete(threadId);
    for (const key of this.deniedThisTurn)
      if (key.startsWith(`${threadId}\0`)) this.deniedThisTurn.delete(key);
  }
  close(): void {
    for (const requestId of this.pending.keys()) this.deny(requestId);
    this.bindings.clear();
    this.deniedThisTurn.clear();
  }
}
