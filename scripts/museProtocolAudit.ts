/**
 * Pure helpers for `audit-muse-protocol.ts`: extract the stable MSP surface
 * from the SDK's bundled wire declarations and diff it against F5's manifest.
 */
import {
  MUSE_CLIENT_METHODS_USED,
  MUSE_NOTIFICATION_DISPOSITIONS,
  MUSE_SERVER_REQUEST_DISPOSITIONS,
} from "@t3tools/shared/museProtocolManifest";

export interface MuseProtocolSurface {
  readonly methods: ReadonlyArray<string>;
  readonly notifications: ReadonlyArray<string>;
  readonly serverRequests: ReadonlyArray<string>;
}

function unionMembers(source: string, typeName: string): string[] {
  const match = new RegExp(`export type ${typeName} = ([^;]+);`).exec(source);
  if (!match?.[1]) throw new Error(`MSP declarations have no ${typeName} union.`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]!).toSorted();
}

export function extractMuseProtocolSurface(declarations: string): MuseProtocolSurface {
  return {
    methods: unionMembers(declarations, "MspMethod"),
    notifications: unionMembers(declarations, "MspNotification"),
    serverRequests: unionMembers(declarations, "MspServerRequest"),
  };
}

export interface MuseProtocolDrift {
  /** Notifications without an F5 disposition. */
  readonly unclassifiedNotifications: ReadonlyArray<string>;
  /** Dispositions for notifications the host no longer sends. */
  readonly removedNotifications: ReadonlyArray<string>;
  readonly unclassifiedServerRequests: ReadonlyArray<string>;
  /** Client methods F5 sends that the host no longer offers. */
  readonly missingMethods: ReadonlyArray<string>;
}

export function diffMuseProtocolSurface(surface: MuseProtocolSurface): MuseProtocolDrift {
  const notifications = new Set(surface.notifications);
  const classified = new Set(Object.keys(MUSE_NOTIFICATION_DISPOSITIONS));
  const requests = new Set(Object.keys(MUSE_SERVER_REQUEST_DISPOSITIONS));
  const methods = new Set(surface.methods);
  return {
    unclassifiedNotifications: surface.notifications.filter((name) => !classified.has(name)),
    removedNotifications: [...classified].filter((name) => !notifications.has(name)).toSorted(),
    unclassifiedServerRequests: surface.serverRequests.filter((name) => !requests.has(name)),
    missingMethods: MUSE_CLIENT_METHODS_USED.filter((name) => !methods.has(name)),
  };
}

export function hasMuseProtocolDrift(drift: MuseProtocolDrift): boolean {
  return Object.values(drift).some((entries) => entries.length > 0);
}
