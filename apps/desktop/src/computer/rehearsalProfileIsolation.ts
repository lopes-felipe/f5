import { Schema } from "effect";
import { DesktopComputerHostMessage } from "@t3tools/contracts";
import { PROFILE_OBSERVATION_REQUEST_LIMIT } from "@t3tools/shared/computerRehearsalProfiles";
import {
  ElectronRehearsalObservation,
  rehearsalProviderActivityCounts,
  rehearsalSessionErrorCode,
} from "./rehearsalElectronObservation";

type Identity = { profileId: string; threadId: string; appId: string; privateTitle: string };
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Distinguish observer faults from evaluator transport failures without error I/O. */
export function profileSnapshotEnvelope(read: () => unknown) {
  try {
    // The observer already discards raw I/O. Send its complete snapshot as one
    // bounded string instead of passing the growing tree through CDP's serializer.
    const value = JSON.stringify(read());
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 512 * 1024)
      return { failed: true as const };
    return { value, failed: false as const };
  } catch {
    return { failed: true as const };
  }
}

/** The host lease and provider projection are separate asynchronous reads.
 * A terminal projection must not trigger cleanup of a newly acquired lease. */
export async function profileOwnerLeaseReady(
  readHeld: () => Promise<boolean>,
  readTurn: () => Promise<{ turnId: string; state: string } | null | undefined>,
  previousTurnId: string | undefined,
): Promise<boolean> {
  if (await readHeld()) return true;
  const turn = await readTurn();
  if (
    turn &&
    turn.turnId !== previousTurnId &&
    ["completed", "error", "interrupted"].includes(turn.state)
  ) {
    if (await readHeld()) return true;
    throw new Error("Isolation owner turn ended without a lease.");
  }
  return false;
}

/** Provider/UI failures can happen before any host call. Fixed states and
 * canonical decision counts distinguish those cases without keeping content. */
export function profileProviderProgress(thread: unknown, activities: unknown) {
  const t = record(thread) ? thread : {};
  const turn = record(t.latestTurn) ? t.latestTurn : {};
  const session = record(t.session) ? t.session : {};
  return {
    threadObserved: record(thread),
    turnState:
      typeof turn.state === "string" &&
      ["pending", "running", "completed", "interrupted", "error"].includes(turn.state)
        ? turn.state
        : "unknown",
    runtimeMode:
      typeof t.runtimeMode === "string" &&
      ["full-access", "approval-required"].includes(t.runtimeMode)
        ? t.runtimeMode
        : "unknown",
    sessionErrorCode: rehearsalSessionErrorCode(session.lastError),
    activityCounts: rehearsalProviderActivityCounts(activities),
  };
}

/** Unsigned observation only. No transport, authorization or result-writing methods.
 * Identities exist transiently for comparisons; snapshots retain counts/booleans only. */
export class RehearsalProfileIsolation {
  private identities: readonly Identity[] = [];
  private readonly native = [
    new ElectronRehearsalObservation(PROFILE_OBSERVATION_REQUEST_LIMIT),
    new ElectronRehearsalObservation(PROFILE_OBSERVATION_REQUEST_LIMIT),
  ];
  private readonly stats = [this.empty(), this.empty()];
  private messages = 0;
  private invalid = false;
  private configured = false;
  private empty() {
    return {
      held: false,
      anonymousBanners: 0,
      ownBanners: 0,
      ownActivities: 0,
      ownImages: 0,
      busy: 0,
      grants: 0,
      ownWsActivities: 0,
      ownWsImages: 0,
      foreignActivity: false,
      foreignImages: false,
      foreignGrants: false,
      foreignIdentity: false,
      invalidBanner: false,
      busyWhileForeignHeld: false,
    };
  }
  configure(identities: readonly Identity[]) {
    if (
      this.configured ||
      identities.length !== 2 ||
      identities.some(
        (i) => !/^[0-9a-f]{32}$/.test(i.profileId) || !i.threadId || !i.appId || !i.privateTitle,
      ) ||
      new Set(identities.map((i) => i.profileId)).size !== 2 ||
      new Set(identities.map((i) => i.threadId)).size !== 2 ||
      new Set(identities.map((i) => i.appId)).size !== 2 ||
      new Set(identities.map((i) => i.privateTitle)).size !== 2
    )
      throw new Error("Invalid isolation identity.");
    this.configured = true;
    this.identities = identities;
  }
  receive(profileId: string, input: unknown, direction: "backend" | "main") {
    if (!this.configured) return;
    const index = this.identities.findIndex((i) => i.profileId === profileId);
    // Decode (not `is`): legacy holders without a scope decode to the foreground scope.
    const decoded = Schema.decodeUnknownExit(DesktopComputerHostMessage)(input);
    if (index < 0 || ++this.messages > 4096 || decoded._tag !== "Success") {
      this.invalid = true;
      return;
    }
    const raw = decoded.value;
    const identity = this.identities[index]!;
    const foreign = this.identities[1 - index]!;
    const stats = this.stats[index]!;
    this.native[index]!.receive(raw);
    if (direction !== "main") return;
    // Do not scan untrusted screen text/results: allowed apps may legitimately
    // display arbitrary strings. Control-plane identity and activity stay private.
    if (raw.type === "activity") {
      stats.ownActivities++;
      const image = !!raw.activity.thumbnailDataUrl;
      if (image) stats.ownImages++;
      if (raw.activity.threadId !== identity.threadId) {
        stats.foreignActivity = true;
        stats.foreignImages ||= image;
      }
    } else if (raw.type === "leaseChanged") {
      stats.held = raw.holder !== null;
      if (raw.otherProfile) {
        stats.anonymousBanners++;
        if (raw.holder !== null) stats.invalidBanner = true;
      } else if (raw.holder) {
        stats.ownBanners++;
        if (raw.holder.profileId !== profileId || raw.holder.threadId !== identity.threadId)
          stats.invalidBanner = true;
      }
    } else if (raw.type === "leasesChanged") {
      stats.held = raw.holders.length > 0;
      if (raw.otherProfile) stats.anonymousBanners++;
      if (raw.holders.length) stats.ownBanners++;
      if (
        raw.holders.some(
          (holder) => holder.profileId !== profileId || holder.threadId !== identity.threadId,
        )
      )
        stats.invalidBanner = true;
    } else if (raw.type === "response" && raw.error?._tag === "Busy") {
      stats.busy++;
      stats.busyWhileForeignHeld ||=
        this.stats[1 - index]!.held && !stats.held && raw.error.holder === "other-profile";
      if (raw.error.threadTitle !== undefined) stats.foreignIdentity = true;
    }
    if (
      [
        "leaseChanged",
        "leasesChanged",
        "executionStateChanged",
        "activity",
        "pauseChanged",
        "accessRequested",
        "accessAnswer",
      ].includes(raw.type)
    ) {
      const encoded = JSON.stringify(raw);
      stats.foreignIdentity ||=
        encoded.includes(foreign.threadId) || encoded.includes(foreign.privateTitle);
    }
  }
  push(index: number, channel: string, data: unknown) {
    if (!this.configured || (index !== 0 && index !== 1) || !record(data)) {
      this.invalid = true;
      return;
    }
    if (++this.messages > 4096) {
      this.invalid = true;
      return;
    }
    const stats = this.stats[index]!;
    const own = this.identities[index]!;
    const foreign = this.identities[1 - index]!;
    if (channel === "computer.activity") {
      stats.ownWsActivities++;
      if (typeof data.thumbnailDataUrl === "string") stats.ownWsImages++;
      if (data.threadId !== own.threadId) {
        stats.foreignActivity = true;
        stats.foreignImages ||= typeof data.thumbnailDataUrl === "string";
      }
    } else if (channel === "computer.access.grantsChanged") {
      stats.grants++;
      if (
        data.threadId !== own.threadId ||
        !Array.isArray(data.grants) ||
        data.grants.some((g) => !record(g) || g.appId !== own.appId)
      )
        stats.foreignGrants = true;
    } else if (channel === "computer.access.requested") {
      if (
        data.threadId !== own.threadId ||
        !Array.isArray(data.apps) ||
        data.apps.some((a) => !record(a) || a.appId !== own.appId)
      )
        stats.foreignGrants = true;
    } else if (channel === "agent.computerUseChanged") {
      if (
        data.otherProfile === true &&
        (data.threadId !== null ||
          Object.keys(data).some((k) => !["threadId", "otherProfile", "backend"].includes(k)))
      )
        stats.invalidBanner = true;
    }
    if (
      [
        "computer.activity",
        "computer.access.grantsChanged",
        "computer.access.requested",
        "agent.computerUseChanged",
        "orchestration.domainEvent",
      ].includes(channel)
    ) {
      const encoded = JSON.stringify(data);
      stats.foreignIdentity ||=
        encoded.includes(foreign.threadId) || encoded.includes(foreign.privateTitle);
    }
  }
  snapshot() {
    return {
      configured: this.configured,
      traceComplete: this.configured && !this.invalid,
      profiles: this.stats.map((s, i) => ({ ...s, native: this.native[i]!.snapshot() })),
    };
  }
}
