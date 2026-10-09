import { randomUUID } from "node:crypto";
import type {
  ComputerAccessAnswer,
  ComputerAccessRequested,
  ComputerApp,
  ComputerGrant,
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
}
export interface RememberedComputerGrant extends ComputerGrant {
  readonly projectId: string;
}
interface Pending {
  request: ComputerAccessRequested;
  generation: string;
  turnId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: ComputerAccessAnswer | null) => void;
}
export interface ComputerAccessStorage {
  load: () => Promise<ReadonlyArray<RememberedComputerGrant>>;
  save: (grants: ReadonlyArray<RememberedComputerGrant>) => Promise<void>;
}
/** Server-owned storage; settings and agent tool inputs cannot supply grants. */
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
      request: (request: ComputerAccessRequested) => void;
      settled: (requestId: string, threadId: string, allowed: boolean) => void;
      changed: (threadId: string) => void;
      timeoutMs?: number;
      runtimeF5Ids?: ReadonlyArray<string>;
    },
  ) {}
  async initialize(): Promise<void> {
    this.remembered = (await this.options.storage.load())
      .filter((grant) => grant.appId && grant.projectId && grant.tier !== "blocked")
      .map((grant) => ({
        ...grant,
        appId: this.options.platform === "win32" ? grant.appId.toLowerCase() : grant.appId,
        tier: restrictComputerTier(
          grant.tier,
          appTier(grant.appId, this.options.platform, this.options.runtimeF5Ids ?? []),
        ),
        allowTyping:
          restrictComputerTier(
            grant.tier,
            appTier(grant.appId, this.options.platform, this.options.runtimeF5Ids ?? []),
          ) === "click" && grant.allowTyping,
      }));
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
    });
  }
  version(threadId: string): number {
    return this.bindings.get(threadId)?.version ?? 0;
  }
  actionsApproved(threadId: string): boolean {
    return this.bindings.get(threadId)?.actionsApproved ?? false;
  }
  pendingRequests(): ReadonlyArray<ComputerAccessRequested> {
    return [...this.pending.values()].map((entry) => entry.request);
  }
  grants(threadId: string): ReadonlyArray<ComputerGrant> {
    const binding = this.bindings.get(threadId);
    if (!binding) return [];
    const grants = new Map(
      this.remembered
        .filter((grant) => grant.projectId === binding.projectId)
        .map((grant) => [
          grant.appId,
          { appId: grant.appId, tier: grant.tier, allowTyping: grant.allowTyping },
        ]),
    );
    for (const [appId, grant] of binding.overrides) {
      if (grant) grants.set(appId, grant);
      else grants.delete(appId);
    }
    return [...grants.values()].filter(
      (grant) =>
        appTier(grant.appId, this.options.platform, this.options.runtimeF5Ids ?? []) !== "blocked",
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
    kind: "apps" | "session-actions" = "apps",
  ): Promise<ComputerAccessAnswer | null> {
    const binding = this.bindings.get(threadId);
    if (!binding) throw new ComputerControlError({ _tag: "Interrupted", cause: "turn-ended" });
    const candidates = apps
      .filter(
        (app) =>
          app.tier !== "blocked" &&
          appTier(app.appId, this.options.platform, this.options.runtimeF5Ids ?? []) !== "blocked",
      )
      .filter(
        (app) =>
          !this.grants(threadId).some(
            (grant) =>
              grant.appId === app.appId &&
              grant.tier ===
                restrictComputerTier(
                  app.tier,
                  appTier(app.appId, this.options.platform, this.options.runtimeF5Ids ?? []),
                ),
          ),
      )
      .filter((app) => !this.deniedThisTurn.has(`${threadId}\0${turnId}\0${app.appId}`));
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
      threadId,
      reason: reason.slice(0, 500),
      kind,
      apps: candidates.slice(0, 10).map((app) => ({
        appId: app.appId,
        name: app.name,
        tier: restrictComputerTier(
          app.tier,
          appTier(app.appId, this.options.platform, this.options.runtimeF5Ids ?? []),
        ),
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
        timer,
        resolve,
      });
      this.options.request(request);
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
      const decisions = pending.request.apps.map((app) => {
        const decision = answer.decisions.find((entry) => entry.appId === app.appId);
        return {
          appId: app.appId,
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
          });
        }
      const rememberChanged = decisions.some((decision) => decision.allow && decision.remember);
      if (rememberChanged) await this.options.storage.save(next);
      // A turn can end while storage is being written. Never revive its session grants.
      if (
        this.pending.get(answer.requestId) !== pending ||
        this.bindings.get(pending.request.threadId) !== binding
      ) {
        if (rememberChanged) await this.options.storage.save(this.remembered);
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
        const app = pending.request.apps.find((entry) => entry.appId === decision.appId)!;
        binding.overrides.set(
          app.appId,
          decision.allow
            ? { appId: app.appId, tier: app.tier, allowTyping: decision.allowTyping }
            : null,
        );
        if (!decision.allow)
          this.deniedThisTurn.add(`${pending.request.threadId}\0${pending.turnId}\0${app.appId}`);
      }
      if (pending.request.kind === "session-actions") {
        binding.actionsApproved = answer.allowSessionActions === true;
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
        decisions.some((decision) => decision.allow) || binding.actionsApproved,
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
      this.deniedThisTurn.add(`${pending.request.threadId}\0${pending.turnId}\0${app.appId}`);
    if (pending.request.kind === "session-actions")
      this.deniedThisTurn.add(`${pending.request.threadId}\0${pending.turnId}\0session-actions`);
    pending.resolve(null);
    this.options.settled(requestId, pending.request.threadId, false);
  }
  revoke(threadId: string, appId: string): void {
    if (this.options.platform === "win32") appId = appId.toLowerCase();
    const binding = this.bindings.get(threadId);
    if (!binding) return;
    binding.overrides.set(appId, null);
    ++binding.version;
    this.options.changed(threadId);
  }
  policyChanged(threadId: string): void {
    const binding = this.bindings.get(threadId);
    if (!binding) return;
    for (const grant of this.grants(threadId)) binding.overrides.set(grant.appId, null);
    binding.actionsApproved = false;
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
      await this.options.storage.save(next);
      this.remembered = next;
      for (const [threadId, binding] of this.bindings)
        if (binding.projectId === projectId) {
          ++binding.version;
          this.options.changed(threadId);
        }
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
  }
  close(): void {
    for (const requestId of this.pending.keys()) this.deny(requestId);
    this.bindings.clear();
  }
}
