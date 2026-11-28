import { WS_CHANNELS, WS_METHODS } from "@t3tools/contracts";
import type {
  MobileAccessStatus,
  MobileDeviceSummary,
  MobilePairingCode,
} from "@t3tools/contracts/mobile/v1";
import { Link } from "@tanstack/react-router";
import qrCode from "qrcode-generator";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useSettings } from "../../hooks/useSettings";
import { phoneAccessTransport } from "../../wsNativeApi";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsCard, SettingsRow } from "./SettingsCard";

const statusLabel: Record<MobileAccessStatus["state"], string> = {
  off: "Off",
  listening: "Listening",
  "waiting-for-tailscale": "Waiting for Tailscale",
  error: "Unavailable",
};

export function PhoneAccessSettings() {
  const config = useSettings((settings) => settings.mobileAccess);
  const [status, setStatus] = useState<MobileAccessStatus | null>(null);
  const [devices, setDevices] = useState<MobileDeviceSummary[]>([]);
  const [pairing, setPairing] = useState<MobilePairingCode | null>(null);
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const transport = useMemo(phoneAccessTransport, []);
  const seconds = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0;
  const qr = useMemo(() => {
    if (!pairing) return null;
    const code = qrCode(0, "M");
    code.addData(pairing.url);
    code.make();
    return code.createDataURL(5, 20);
  }, [pairing]);

  useEffect(() => {
    let alive = true;
    const unsubscribe = transport.subscribe(WS_CHANNELS.mobileAccessStatusUpdated, ({ data }) => {
      setStatus((previous) => ({
        ...(previous?.apnsKeyStored === undefined ? {} : { apnsKeyStored: previous.apnsKeyStored }),
        ...data,
      }));
      if (data.state !== "listening") setPairing(null);
    });
    void transport.request<MobileAccessStatus>(WS_METHODS.mobileAccessGetStatus, {}).then(
      (data) => {
        if (alive) setStatus(data);
      },
      () => {
        if (alive) setNotice("Could not read Phone access status.");
      },
    );
    const refresh = () => {
      void transport.request<MobileDeviceSummary[]>(WS_METHODS.mobileAccessListDevices, {}).then(
        (list) => {
          if (alive) setDevices(list);
        },
        () => {},
      );
    };
    refresh();
    const interval = window.setInterval(refresh, 15_000);
    return () => {
      alive = false;
      unsubscribe();
      window.clearInterval(interval);
    };
  }, [transport]);

  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [pairing]);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    try {
      await action();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveApns(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const file = fields.get("privateKey");
    const form = event.currentTarget;
    await perform(async () => {
      if (file instanceof File && file.size > 4096) throw new Error("Choose an APNs .p8 key.");
      const result = await transport.request<{ configured: boolean }>(
        WS_METHODS.mobileAccessSetApnsConfig,
        {
          teamId: String(fields.get("teamId") ?? "").trim(),
          keyId: String(fields.get("keyId") ?? "").trim(),
          baseBundleId: String(fields.get("baseBundleId") ?? "").trim(),
          ...(file instanceof File && file.size ? { privateKey: await file.text() } : {}),
        },
      );
      const fileInput = form.elements.namedItem("privateKey");
      if (fileInput instanceof HTMLInputElement) fileInput.value = "";
      setStatus(await transport.request<MobileAccessStatus>(WS_METHODS.mobileAccessGetStatus, {}));
      setNotice(
        result.configured
          ? "APNs configuration saved."
          : "Saved. Enable Phone access with a valid key to test APNs.",
      );
    });
  }

  async function updateDevice(method: string, input: { deviceId: string; name?: string }) {
    await perform(async () => {
      if (!(await transport.request<boolean>(method, input)))
        throw new Error("This device is no longer paired.");
      setRevokeId(null);
      setDevices(
        await transport.request<MobileDeviceSummary[]>(WS_METHODS.mobileAccessListDevices, {}),
      );
    });
  }

  return (
    <div className="space-y-4">
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <SettingsCard
        title="Phone access"
        searchTarget="phone.access"
        description="Connect the F5 app on your iPhone to this profile over Tailscale."
      >
        <SettingsRow
          title="Allow paired phones"
          description={status ? statusLabel[status.state] : "Checking connection…"}
          control={
            <Switch
              aria-label="Allow paired phones"
              checked={config?.enabled ?? false}
              disabled={busy || !status}
              onCheckedChange={(enabled) =>
                void perform(async () => {
                  setStatus(
                    await transport.request<MobileAccessStatus>(WS_METHODS.mobileAccessSetEnabled, {
                      enabled,
                    }),
                  );
                  if (!enabled) setPairing(null);
                })
              }
            />
          }
        />
        {status?.state === "listening" && (
          <p className="my-2 text-sm text-muted-foreground">
            {status.magicDnsName ?? status.address} · Port {status.port}
          </p>
        )}
        {status?.message && <p className="my-2 text-sm">{status.message}</p>}
        {status?.requiresConfirmation && status.address && (
          <SettingsRow
            title="Confirm Tailscale interface"
            description={"Check this address in Tailscale before confirming: " + status.address}
            control={
              <Button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    setStatus(
                      await transport.request<MobileAccessStatus>(
                        WS_METHODS.mobileAccessConfirmInterface,
                        { address: status.address },
                      ),
                    );
                  })
                }
              >
                Confirm interface
              </Button>
            }
          />
        )}
        <Button
          className="mt-3"
          disabled={busy || status?.state !== "listening"}
          onClick={() =>
            void perform(async () => {
              const next = await transport.request<MobilePairingCode>(
                WS_METHODS.mobileAccessCreatePairingCode,
                {},
              );
              setNow(Date.now());
              setPairing(next);
            })
          }
        >
          Pair a phone
        </Button>
        {pairing && seconds > 0 && qr && (
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <img src={qr} alt="F5 pairing QR code" className="h-44 w-44 rounded-md" />
            <div className="min-w-0 space-y-1">
              <p className="text-sm">Scan in the F5 app or enter the origin and code.</p>
              <p className="break-all font-mono text-xs">
                {new URL(pairing.url).searchParams.get("o")}
              </p>
              <p className="font-mono text-lg tracking-wider">{pairing.code}</p>
              <p className="text-xs text-muted-foreground">
                Expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
              </p>
            </div>
          </div>
        )}
      </SettingsCard>
      <SettingsCard title="Paired devices">
        {devices.length === 0 && <p className="text-sm text-muted-foreground">No paired phones.</p>}
        {devices.map((device) => (
          <SettingsRow
            key={device.deviceId}
            title={device.name}
            description={
              device.platform +
              " · v" +
              device.appVersion +
              " · Seen " +
              new Date(device.lastSeenAt).toLocaleString() +
              (device.pushRegistered ? " · Push registered" : " · Push unavailable")
            }
          >
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
                if (name)
                  void updateDevice(WS_METHODS.mobileAccessRenameDevice, {
                    deviceId: device.deviceId,
                    name,
                  });
              }}
            >
              <Input
                className="max-w-52"
                name="name"
                defaultValue={device.name}
                required
                maxLength={128}
                aria-label={"Name for " + device.name}
              />
              <Button type="submit" size="sm" variant="outline" disabled={busy}>
                Rename
              </Button>
              {revokeId === device.deviceId ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    onClick={() =>
                      void updateDevice(WS_METHODS.mobileAccessRevokeDevice, {
                        deviceId: device.deviceId,
                      })
                    }
                  >
                    Confirm revoke
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setRevokeId(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setRevokeId(device.deviceId)}
                >
                  Revoke
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || !device.pushRegistered || status?.state !== "listening"}
                onClick={() =>
                  void perform(async () => {
                    await transport.request(WS_METHODS.mobileAccessSendTestNotification, {
                      deviceId: device.deviceId,
                    });
                    setNotice("APNs accepted the test notification.");
                  })
                }
              >
                Send test notification
              </Button>
            </form>
          </SettingsRow>
        ))}
      </SettingsCard>
      <SettingsCard
        title="Apple Push Notification service"
        searchTarget="phone.push"
        description={
          <>
            Push delivery pauses while the host sleeps.{" "}
            <Link
              className="underline"
              to="/settings"
              search={{ category: "threads", item: "threads.keep-awake" }}
            >
              Keep the host awake while agents work
            </Link>
            .
          </>
        }
      >
        <form
          key={JSON.stringify(config?.apns)}
          className="grid max-w-md gap-3"
          onSubmit={(event) => void saveApns(event)}
        >
          <label className="text-sm">
            Apple team ID
            <Input name="teamId" required maxLength={10} defaultValue={config?.apns.teamId} />
          </label>
          <label className="text-sm">
            APNs key ID
            <Input name="keyId" required maxLength={10} defaultValue={config?.apns.keyId} />
          </label>
          <label className="text-sm">
            Base bundle ID
            <Input
              name="baseBundleId"
              required
              maxLength={128}
              defaultValue={config?.apns.baseBundleId || "io.github.lopesfelipe.f5.mobile"}
            />
          </label>
          <label className="text-sm">
            APNs private key (.p8)
            <Input name="privateKey" type="file" accept=".p8" />
          </label>
          {status?.apnsKeyStored && config?.apns && (
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">Private key stored</span>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await transport.request(WS_METHODS.mobileAccessSetApnsConfig, {
                      ...config.apns,
                      privateKey: null,
                    });
                    setStatus(
                      await transport.request<MobileAccessStatus>(
                        WS_METHODS.mobileAccessGetStatus,
                        {},
                      ),
                    );
                    setNotice("APNs private key removed.");
                  })
                }
              >
                Remove key
              </Button>
            </div>
          )}
          <Button type="submit" className="justify-self-start" disabled={busy}>
            Save APNs settings
          </Button>
        </form>
      </SettingsCard>
    </div>
  );
}
