import {
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_IMAGE_BYTES,
  ATTACHMENT_MAX_IMAGES_BYTES,
  type OrchestrationEvent,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  MOBILE_API_VERSION,
  type MobileAccessStatus,
  type MobileBootstrap,
  type MobileDeviceSummary,
  type MobileApnsUpdate,
} from "@t3tools/contracts/mobile/v1";
import { Effect } from "effect";
import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore.ts";
import { makeMobileDeviceStore } from "./deviceStore.ts";
import { makeMobileListener, MobileRouteError } from "./listener.ts";
import { makeMobileLiveBatches } from "./liveBatches.ts";
import type { makeMobileApi } from "./mobileApi.ts";
import { makeMobileAuth } from "./mobileAuth.ts";
import { detectTailscale, formatMobileHost, type TailscaleInterface } from "./tailscale.ts";
import { acceptsPushBundle, makeMobilePushReactor } from "./pushReactor.ts";
import {
  makeApnsClient,
  MOBILE_APNS_KEY_SECRET,
  MOBILE_ID_SECRET,
  readApnsKey,
} from "./apnsClient.ts";

type Config = ServerSettings["mobileAccess"];
type Update = NonNullable<ServerSettingsPatch["mobileAccess"]>;
const DEFAULT_PORT = 37730;

export const makeMobileAccessService = (options: {
  secrets: ServerSecretStoreShape;
  incarnation: string;
  profileName: string;
  serverVersion: string;
  isReady: () => boolean;
  healthy: () => boolean;
  api: ReturnType<typeof makeMobileApi>;
  detectInterface?: typeof detectTailscale;
  attachments: NonNullable<Parameters<typeof makeMobileListener>[0]["attachments"]>;
  update: (patch: Update) => Promise<ServerSettings>;
  onStatus: (status: MobileAccessStatus) => void;
}) =>
  Effect.gen(function* () {
    const store = yield* makeMobileDeviceStore;
    const auth = makeMobileAuth(store.byHash);
    const live = makeMobileLiveBatches({
      backendIncarnation: options.incarnation,
      head: async () => (await options.api.readModel()).snapshotSequence,
      replay: options.api.replay,
    });
    let status: MobileAccessStatus = { state: "off" };
    let serverId = "";
    let config: Config | undefined;
    let detected: TailscaleInterface | null = null;
    let running: { key: string; listener: ReturnType<typeof makeMobileListener> } | null = null;
    let stopped = false;
    let reconcile = Promise.resolve();
    let apns: { client: ReturnType<typeof makeApnsClient>; baseBundleId: string } | null = null;
    let loadedApnsConfig = "";
    const pushes = makeMobilePushReactor({
      serverId: () => serverId,
      readShell: options.api.shell,
      store,
      client: () => apns,
    });

    const minOverride = process.env.F5_MOBILE_API_MIN_SUPPORTED_OVERRIDE;
    const mobileApi = {
      current: MOBILE_API_VERSION,
      min:
        minOverride && /^[1-9][0-9]?$/.test(minOverride) ? Number(minOverride) : MOBILE_API_VERSION,
    };
    function bootstrap(): typeof MobileBootstrap.Type {
      return {
        serverId,
        mobileApi,
        profileName: options.profileName,
        serverVersion: options.serverVersion,
        backendIncarnation: options.incarnation,
        ready: options.isReady(),
        health: options.healthy() ? "ok" : "degraded",
        attachmentLimits: {
          maxCount: ATTACHMENT_MAX_COUNT,
          maxImageBytes: ATTACHMENT_MAX_IMAGE_BYTES,
          maxImagesBytes: ATTACHMENT_MAX_IMAGES_BYTES,
        },
      };
    }
    function emit(next: MobileAccessStatus) {
      if (JSON.stringify(status) === JSON.stringify(next)) return;
      status = next;
      options.onStatus(status);
    }
    async function closeListener() {
      pushes.enabled(false);
      apns?.client.close();
      apns = null;
      loadedApnsConfig = "";
      auth.clearCodes();
      const old = running;
      running = null;
      await old?.listener.close();
    }
    async function refreshApns(value: Config["apns"]) {
      const key = JSON.stringify(value);
      if (loadedApnsConfig === key) return;
      loadedApnsConfig = key;
      apns?.client.close();
      apns = null;
      if (!value.teamId || !value.keyId || !value.baseBundleId) return;
      try {
        const bytes = await Effect.runPromise(options.secrets.get(MOBILE_APNS_KEY_SECRET));
        if (!bytes) return;
        apns = {
          client: makeApnsClient({
            key: readApnsKey(Buffer.from(bytes).toString("utf8")),
            teamId: value.teamId,
            keyId: value.keyId,
          }),
          baseBundleId: value.baseBundleId,
        };
      } catch {
        // A restored profile may have public APNs configuration and need a fresh key.
        loadedApnsConfig = "";
      }
    }
    async function refresh() {
      if (!config?.enabled || stopped) {
        await closeListener();
        detected = null;
        emit({ state: "off" });
        return;
      }
      let network: TailscaleInterface | null;
      try {
        network = await (options.detectInterface ?? detectTailscale)();
      } catch {
        // A failed probe does not establish that the bound interface disappeared.
        if (!running)
          emit({
            state: "waiting-for-tailscale",
            message: "Tailscale status is temporarily unavailable.",
          });
        return;
      }
      if (!config.enabled || stopped) return;
      detected = network;
      if (!config.enabled || stopped) return;
      if (
        !network ||
        (network.detection === "heuristic" && config.confirmedInterface !== network.address)
      ) {
        await closeListener();
        emit({
          state: "waiting-for-tailscale",
          ...(network ? { ...network, requiresConfirmation: true } : {}),
        });
        return;
      }
      const choosePort = config.port === null;
      const port = config.port ?? DEFAULT_PORT;
      const key = JSON.stringify([network, port]);
      if (running?.key === key) {
        await refreshApns(config.apns);
        return;
      }
      await closeListener();
      if (!serverId) {
        const bytes = await Effect.runPromise(
          options.secrets.getOrCreateRandom(MOBILE_ID_SECRET, 24),
        );
        serverId = Buffer.from(bytes).toString("base64url");
      }
      if (!config.enabled || stopped) return;
      const listener = makeMobileListener({
        network,
        port,
        choosePort,
        bootstrap,
        store,
        auth,
        readShell: options.api.shell,
        attachments: options.attachments,
        onError: () => {
          if (running?.listener !== listener) return;
          void closeListener();
          emit({ state: "error", message: "Phone access lost its listener." });
        },
        call: async (peer, call) => {
          if (call.method === "probe") return bootstrap();
          if (call.method === "registerPush") {
            const { pushToken, environment, bundleId } = call.body;
            if (bundleId !== peer.device.bundle_id || peer.device.platform !== "ios")
              throw new MobileRouteError("invalid-request");
            await Effect.runPromise(store.registerPush(peer.device, pushToken, environment));
            return { registered: true };
          }
          if (call.method === "setPresence") {
            pushes.presence(peer, call.body.foreground, call.body.viewingThreadId);
            return { updated: true };
          }
          if (call.method === "setNotificationPrefs") {
            await Effect.runPromise(store.setPrefs(peer.device, call.body));
            return { updated: true };
          }
          if (call.method === "unregisterPush") {
            const token = peer.device.push_token;
            if (token) await Effect.runPromise(store.clearPush(peer.device, token));
            return { updated: true };
          }
          if (!options.isReady()) throw new MobileRouteError("starting");
          if (call.method === "subscribe")
            return live.subscribe(peer, call.body.selectedThreadId, call.body.resume);
          return options.api.call(
            call,
            () => store.active(peer.device) && config?.enabled === true && !stopped,
          );
        },
      });
      let boundPort: number;
      try {
        boundPort = await listener.listen();
        if (choosePort && config.enabled && !stopped && config.port === null) {
          await options.update({ port: boundPort });
          if (config.port === null) config = { ...config, port: boundPort };
        }
      } catch {
        await listener.close();
        emit({
          state: "error",
          ...network,
          port,
          message: "Could not bind the Phone access port.",
        });
        return;
      }
      if (!config.enabled || stopped || config.port !== boundPort) {
        await listener.close();
        return;
      }
      running = { key: JSON.stringify([network, boundPort]), listener };
      await refreshApns(config.apns);
      pushes.enabled(true);
      emit({ state: "listening", ...network, port: boundPort });
    }
    function scheduleRefresh() {
      reconcile = reconcile.then(refresh).catch(async () => {
        await closeListener();
        emit({ state: "error", message: "Phone access could not start." });
      });
      return reconcile;
    }
    function apply(next: Config) {
      const previous = config;
      config = next;
      if (!next.enabled && previous?.enabled) auth.clearCodes();
      return previous?.enabled !== next.enabled ||
        previous.port !== next.port ||
        previous.confirmedInterface !== next.confirmedInterface ||
        JSON.stringify(previous.apns) !== JSON.stringify(next.apns)
        ? scheduleRefresh()
        : reconcile;
    }
    const detectTimer = setInterval(() => {
      if (config?.enabled) void scheduleRefresh();
    }, 30_000);
    const seenTimer = setInterval(() => {
      void Effect.runPromise(store.flushSeen).catch(() => {});
    }, 60_000);
    const close = async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(detectTimer);
      clearInterval(seenTimer);
      await reconcile;
      await closeListener();
      await Effect.runPromise(store.flushSeen).catch(() => {});
    };
    async function getStatus(): Promise<MobileAccessStatus> {
      const entries = await Effect.runPromise(options.secrets.list(MOBILE_APNS_KEY_SECRET)).catch(
        () => [],
      );
      return {
        ...status,
        apnsKeyStored: entries.some(({ name }) => name === MOBILE_APNS_KEY_SECRET),
      };
    }
    return {
      apply,
      close,
      event(event: OrchestrationEvent) {
        if (running) {
          live.event(event);
          pushes.event(event);
        }
      },
      getStatus,
      async setEnabled(enabled: boolean) {
        await apply((await options.update({ enabled })).mobileAccess);
        return getStatus();
      },
      async confirmInterface(address: string) {
        if (detected?.detection !== "heuristic" || detected.address !== address)
          throw new MobileRouteError("stale-action");
        await apply((await options.update({ confirmedInterface: address })).mobileAccess);
        return getStatus();
      },
      createPairingCode() {
        if (!running || !detected || !config?.enabled || config.port === null)
          throw new MobileRouteError("starting");
        const { code, expiresAt } = auth.createCode();
        const numeric = "http://" + formatMobileHost(detected.address, config.port);
        const name = detected.magicDnsName;
        const origin =
          name && config.advertisedHost !== detected.address
            ? "http://" + formatMobileHost(name, config.port)
            : numeric;
        const query = new URLSearchParams({
          v: "1",
          o: origin,
          c: code,
          s: serverId,
          n: options.profileName,
        });
        if (numeric !== origin) query.set("o2", numeric);
        return { code, expiresAt, url: "f5://pair?" + query.toString() };
      },
      listDevices(): MobileDeviceSummary[] {
        return Array.from(store.devices(), (device) => ({
          deviceId: device.device_id,
          name: device.name,
          platform: device.platform,
          appVersion: device.app_version,
          createdAt: device.created_at,
          lastSeenAt: device.last_seen_at,
          pushRegistered: device.push_token !== null,
        }));
      },
      renameDevice: store.rename,
      revokeDevice: (id: string) => store.revoke(id, () => running?.listener.revoke(id)),
      async setApnsConfig({ privateKey, ...value }: typeof MobileApnsUpdate.Type) {
        if (
          !/^[A-Z0-9]{10}$/.test(value.teamId) ||
          !/^[A-Z0-9]{10}$/.test(value.keyId) ||
          !/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(value.baseBundleId)
        )
          throw new MobileRouteError("invalid-request");
        if (privateKey !== undefined) {
          if (privateKey === null)
            await Effect.runPromise(options.secrets.remove(MOBILE_APNS_KEY_SECRET));
          else {
            readApnsKey(privateKey);
            await Effect.runPromise(
              options.secrets.set(MOBILE_APNS_KEY_SECRET, Buffer.from(privateKey)),
            );
          }
          loadedApnsConfig = "";
        }
        await apply((await options.update({ apns: value })).mobileAccess);
        if (running) await scheduleRefresh();
        return { configured: apns !== null };
      },
      async sendTestNotification(deviceId: string) {
        const sender = apns;
        const device = Array.from(store.devices()).find((device) => device.device_id === deviceId);
        if (
          !sender ||
          !device?.push_token ||
          !acceptsPushBundle(sender.baseBundleId, device.bundle_id) ||
          (device.push_environment !== "sandbox" && device.push_environment !== "production")
        )
          throw new MobileRouteError("invalid-request");
        const token = device.push_token;
        const result = await sender.client.send({
          bundleId: device.bundle_id,
          token,
          environment: device.push_environment,
          priority: 10,
          collapseId: "f5-test",
          payload: JSON.stringify({ aps: { alert: "F5: Test notification", sound: "default" } }),
        });
        if (result.status === 410 || result.reason === "BadDeviceToken")
          await Effect.runPromise(store.clearPush(device, token));
        if (result.status !== 200) throw new MobileRouteError("rejected");
        return { delivered: true };
      },
    };
  });
