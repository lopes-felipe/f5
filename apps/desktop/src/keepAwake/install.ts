import { app, ipcMain, powerMonitor, powerSaveBlocker, screen } from "electron";
import { join } from "node:path";
import type { DesktopKeepAwakeState } from "@t3tools/contracts";
import { KeepAwakeController } from "./controller";
import { pollActivity, type ActivityBackend } from "./demand";
import { createMacPower } from "./macPower";
import { createLidOwnership } from "./lidOwnership";
import { atomicWrite, readPreferences, type Preferences } from "./preferences";

export function validatePreferences(input: unknown): Partial<Preferences> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid preferences");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length === 0 ||
    Object.keys(value).some(
      (key) => key !== "mode" && key !== "closedLid" && key !== "keepDisplayOn",
    ) ||
    ("mode" in value && !["off", "agents", "always"].includes(value.mode as string)) ||
    ("closedLid" in value && typeof value.closedLid !== "boolean") ||
    ("keepDisplayOn" in value && typeof value.keepDisplayOn !== "boolean")
  )
    throw new Error("Invalid preferences");
  return value as Partial<Preferences>;
}
export async function installKeepAwake(options: {
  authorize(event: Electron.IpcMainInvokeEvent): unknown;
  backends(): ActivityBackend[];
  broadcast(state: DesktopKeepAwakeState): void;
}) {
  const path = join(app.getPath("userData"), "keep-awake.json");
  // Serialize persistence independently of the lid queue; Off is accepted immediately.
  let writes = Promise.resolve();
  const ownership = createLidOwnership(join(app.getPath("userData"), "keep-awake-lid.json"));
  const controller = new KeepAwakeController(await readPreferences(path), {
    platform: process.platform,
    now: Date.now,
    blocker: powerSaveBlocker,
    pollDemand: () => pollActivity(options.backends()),
    power: createMacPower(ownership.runWrite),
    ownership,
    environment: {
      isOnBattery: () => powerMonitor.isOnBatteryPower(),
      thermalState: () => powerMonitor.getCurrentThermalState(),
      hasExternalDisplay: () => screen.getAllDisplays().some((display) => !display.internal),
    },
    save: (value) => {
      writes = writes.catch(() => {}).then(() => atomicWrite(path, value));
      return writes;
    },
    broadcast: options.broadcast,
    log: (error) => console.error("[keep-awake]", error),
  });
  const requireGesture = (trusted: unknown) => {
    if (trusted !== true) throw new Error("Keep awake requires a trusted user gesture");
  };
  for (const suffix of ["get", "set", "install", "remove"])
    ipcMain.removeHandler("desktop:keep-awake-" + suffix);
  ipcMain.handle("desktop:keep-awake-get", (event) => {
    options.authorize(event);
    return controller.getState();
  });
  ipcMain.handle("desktop:keep-awake-set", (event, input: unknown, trusted: unknown) => {
    options.authorize(event);
    const prefs = validatePreferences(input);
    if (
      (prefs.mode !== undefined && prefs.mode !== "off") ||
      prefs.closedLid === true ||
      prefs.keepDisplayOn === true
    )
      requireGesture(trusted);
    return controller.setPreferences(prefs);
  });
  for (const action of ["install", "remove"] as const)
    ipcMain.handle("desktop:keep-awake-" + action, (event, trusted: unknown) => {
      options.authorize(event);
      requireGesture(trusted);
      return controller.changePermission(action === "install");
    });
  const power = () => controller.powerChanged();
  const active = () => controller.userActive();
  powerMonitor.on("on-ac", power);
  powerMonitor.on("on-battery", power);
  powerMonitor.on("thermal-state-change", power);
  powerMonitor.on("user-did-become-active", active);
  void controller.start().catch((error) => console.error("[keep-awake] startup", error));
  return {
    async dispose() {
      powerMonitor.removeListener("on-ac", power);
      powerMonitor.removeListener("on-battery", power);
      powerMonitor.removeListener("thermal-state-change", power);
      powerMonitor.removeListener("user-did-become-active", active);
      await controller.dispose();
    },
  };
}
