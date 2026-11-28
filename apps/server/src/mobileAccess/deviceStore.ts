import { randomBytes, randomUUID } from "node:crypto";
import type { MobileNotificationPrefs, MobilePairRequest } from "@t3tools/contracts/mobile/v1";
import { Effect } from "effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { hashMobileToken } from "./mobileAuth.ts";

export interface MobileDevice {
  device_id: string;
  name: string;
  platform: string;
  app_version: string;
  bundle_id: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  push_token: string | null;
  push_environment: string | null;
  notify_json: string | null;
}

export const makeMobileDeviceStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<MobileDevice>`SELECT * FROM mobile_devices WHERE revoked_at IS NULL`;
  const byHash = new Map(rows.map((device) => [device.token_hash, device]));
  const byId = new Map(rows.map((device) => [device.device_id, device]));
  const pendingSeen = new Map<string, string>();
  const writes = yield* Semaphore.make(1);

  function active(device: MobileDevice) {
    return byId.get(device.device_id) === device;
  }

  return {
    byHash: byHash as ReadonlyMap<string, MobileDevice>,
    active,
    devices: () => byId.values(),
    create: (request: typeof MobilePairRequest.Type) =>
      Effect.gen(function* () {
        const deviceToken = randomBytes(32).toString("base64url");
        const now = new Date().toISOString();
        const device: MobileDevice = {
          device_id: randomUUID(),
          name: request.deviceName,
          platform: request.platform,
          app_version: request.appVersion,
          bundle_id: request.bundleId,
          token_hash: hashMobileToken(deviceToken),
          created_at: now,
          last_seen_at: now,
          push_token: null,
          push_environment: null,
          notify_json: null,
        };
        yield* sql`INSERT INTO mobile_devices (
          device_id, name, platform, app_version, bundle_id, token_hash, created_at, last_seen_at
        ) VALUES (
          ${device.device_id}, ${device.name}, ${device.platform}, ${device.app_version},
          ${device.bundle_id}, ${device.token_hash}, ${now}, ${now}
        )`;
        byHash.set(device.token_hash, device);
        byId.set(device.device_id, device);
        return { deviceId: device.device_id, deviceToken };
      }).pipe(Effect.uninterruptible),
    rename: (id: string, name: string) =>
      Effect.gen(function* () {
        const device = byId.get(id);
        if (!device) return false;
        yield* sql`UPDATE mobile_devices SET name = ${name} WHERE device_id = ${id} AND revoked_at IS NULL`;
        if (active(device)) device.name = name;
        return active(device);
      }),
    revoke: (id: string, disconnect: () => void) =>
      writes.withPermit(
        Effect.gen(function* () {
          const device = byId.get(id);
          if (!device) return false;
          yield* sql`UPDATE mobile_devices
          SET revoked_at = ${new Date().toISOString()}, push_token = NULL
          WHERE device_id = ${id}`;
          byHash.delete(device.token_hash);
          byId.delete(id);
          pendingSeen.delete(id);
          disconnect();
          return true;
        }).pipe(Effect.uninterruptible),
      ),
    touch(device: MobileDevice) {
      if (!active(device)) return;
      const now = new Date().toISOString();
      device.last_seen_at = now;
      pendingSeen.set(device.device_id, now);
    },
    registerPush: (device: MobileDevice, token: string, environment: string) =>
      writes.withPermit(
        Effect.gen(function* () {
          if (!active(device)) return;
          token = token.toLowerCase();
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE mobile_devices SET push_token = NULL, push_environment = NULL
            WHERE device_id != ${device.device_id} AND bundle_id = ${device.bundle_id}
              AND push_environment = ${environment} AND lower(push_token) = ${token}`;
              yield* sql`UPDATE mobile_devices SET push_token = ${token}, push_environment = ${environment}
            WHERE device_id = ${device.device_id} AND revoked_at IS NULL`;
            }),
          );
          for (const other of byId.values()) {
            if (
              other !== device &&
              other.bundle_id === device.bundle_id &&
              other.push_environment === environment &&
              other.push_token?.toLowerCase() === token
            ) {
              other.push_token = null;
              other.push_environment = null;
            }
          }
          device.push_token = token;
          device.push_environment = environment;
        }).pipe(Effect.uninterruptible),
      ),
    clearPush: (device: MobileDevice, token: string) =>
      writes.withPermit(
        Effect.gen(function* () {
          if (!active(device) || device.push_token !== token) return;
          yield* sql`UPDATE mobile_devices SET push_token = NULL, push_environment = NULL
          WHERE device_id = ${device.device_id} AND push_token = ${token} AND revoked_at IS NULL`;
          if (active(device) && device.push_token === token) {
            device.push_token = null;
            device.push_environment = null;
          }
        }).pipe(Effect.uninterruptible),
      ),
    setPrefs: (device: MobileDevice, prefs: MobileNotificationPrefs) =>
      Effect.gen(function* () {
        if (!active(device)) return;
        const value = JSON.stringify(prefs);
        yield* sql`UPDATE mobile_devices SET notify_json = ${value}
          WHERE device_id = ${device.device_id} AND revoked_at IS NULL`;
        if (active(device)) device.notify_json = value;
      }),
    flushSeen: Effect.gen(function* () {
      for (const [id, at] of pendingSeen) {
        yield* sql`UPDATE mobile_devices SET last_seen_at = ${at} WHERE device_id = ${id} AND revoked_at IS NULL`;
        if (pendingSeen.get(id) === at) pendingSeen.delete(id);
      }
    }),
  };
});
