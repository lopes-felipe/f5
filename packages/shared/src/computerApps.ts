import type { ComputerAppTier } from "@t3tools/contracts";

export type ComputerPlatform = "darwin" | "win32";
/** Declarative source for native helper tables; prefixes end in '*'. */
export const COMPUTER_APP_TIERS = {
  darwin: {
    blocked: [
      "com.t3tools.t3code*",
      "com.github.Electron",
      "com.apple.SecurityAgent",
      "com.apple.loginwindow",
      "com.apple.systempreferences",
      "com.apple.Passwords",
      "com.apple.UserNotificationCenter",
      "com.apple.CoreServicesUIAgent",
      "com.apple.ActivityMonitor",
      "com.apple.DiskUtility",
      "com.apple.installer",
    ],
    view: [
      "com.agilebits.onepassword7",
      "com.1password.1password",
      "com.bitwarden.desktop",
      "org.keepassxc.keepassxc",
      "com.apple.keychainaccess",
    ],
    click: [
      "com.apple.Terminal",
      "com.googlecode.iterm2",
      "dev.warp.Warp-Stable",
      "com.mitchellh.ghostty",
      "com.github.wez.wezterm",
      "net.kovidgoyal.kitty",
      "org.alacritty",
      "com.microsoft.VSCode",
      "com.todesktop.230313mzl4w4u92",
      "com.jetbrains.*",
      "com.apple.ScriptEditor2",
      "com.apple.Automator",
      "com.apple.shortcuts",
      "com.anthropic.claudefordesktop",
      "com.openai.chat",
      "com.openai.codex",
    ],
  },
  win32: {
    blocked: [
      "f5.exe",
      "electron.exe",
      "f5 (alpha).exe",
      "f5 (beta).exe",
      "t3 code.exe",
      "t3code.exe",
      "shellexperiencehost.exe",
      "startmenuexperiencehost.exe",
      "microsoft.windows.shellexperiencehost_*",
      "microsoft.windows.startmenuexperiencehost_*",
      "consent.exe",
      "logonui.exe",
      "credentialuibroker.exe",
      "windows.immersivecontrolpanel_cw5n1h2txyewy!*",
      "taskmgr.exe",
      "regedit.exe",
      "mmc.exe",
    ],
    view: ["1password.exe", "bitwarden.exe", "keepassxc.exe", "keepass.exe"],
    click: [
      "windowsterminal.exe",
      "microsoft.windowsterminal_*",
      "cmd.exe",
      "powershell.exe",
      "pwsh.exe",
      "conhost.exe",
      "code.exe",
      "cursor.exe",
      "idea64.exe",
      "pycharm64.exe",
      "webstorm64.exe",
      "rider64.exe",
      "clion64.exe",
      "datagrip64.exe",
      "goland64.exe",
      "phpstorm64.exe",
      "rubymine64.exe",
      "claude.exe",
      "chatgpt.exe",
      "codex.exe",
      "explorer.exe",
    ],
  },
} as const;
export const COMPUTER_BROWSER_IDS = {
  darwin: [
    "com.google.Chrome*",
    "com.apple.Safari*",
    "org.mozilla.firefox*",
    "com.microsoft.edgemac*",
    "com.brave.Browser*",
    "company.thebrowser.Browser*",
    "com.operasoftware.Opera*",
  ],
  win32: ["chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "arc.exe"],
} as const;
export interface RuntimeF5Identity {
  readonly appIds?: ReadonlyArray<string>;
  readonly f5Pids?: ReadonlyArray<number>;
  readonly pid?: number;
  readonly f5BundlePath?: string;
  readonly bundlePath?: string;
}
function matches(id: string, pattern: string): boolean {
  const normalized = pattern.toLowerCase();
  return normalized.endsWith("*") ? id.startsWith(normalized.slice(0, -1)) : id === normalized;
}
function candidates(appId: string, platform: ComputerPlatform): ReadonlyArray<string> {
  const normalized = appId.toLowerCase();
  return platform === "win32"
    ? [normalized, normalized.split(/[\\/]/).at(-1) ?? normalized]
    : [normalized];
}
export function appTier(
  appId: string,
  platform: ComputerPlatform,
  runtimeF5Ids: ReadonlyArray<string> | RuntimeF5Identity = [],
): ComputerAppTier {
  const identity: RuntimeF5Identity = Array.isArray(runtimeF5Ids)
    ? { appIds: runtimeF5Ids }
    : (runtimeF5Ids as RuntimeF5Identity);
  if (
    identity.appIds?.some((id) => id.toLowerCase() === appId.toLowerCase()) ||
    (identity.pid !== undefined && identity.f5Pids?.includes(identity.pid)) ||
    (identity.f5BundlePath !== undefined && identity.bundlePath === identity.f5BundlePath)
  )
    return "blocked";
  const ids = candidates(appId, platform);
  for (const tier of ["blocked", "view", "click"] as const) {
    if (
      COMPUTER_APP_TIERS[platform][tier].some((pattern) => ids.some((id) => matches(id, pattern)))
    )
      return tier;
  }
  // ApplicationFrameHost is a broker, never an app identity. Resolve its child AUMID first.
  if (platform === "win32" && ids.includes("applicationframehost.exe")) return "blocked";
  return "full";
}
export function appWarning(appId: string, platform: ComputerPlatform): "browser" | undefined {
  return COMPUTER_BROWSER_IDS[platform].some((pattern) =>
    candidates(appId, platform).some((id) => matches(id, pattern)),
  )
    ? "browser"
    : undefined;
}
export function classifySystemSurface(
  platform: ComputerPlatform,
  surface: string,
): "system-ui" | undefined {
  const blocked =
    platform === "darwin"
      ? [
          "com.apple.dock",
          "com.apple.controlcenter",
          "com.apple.notificationcenterui",
          "com.apple.spotlight",
          "menu-bar-status-items",
        ]
      : [
          "shell_traywnd",
          "shell_secondarytraywnd",
          "progman",
          "workerw",
          "start",
          "shellexperiencehost.exe",
          "startmenuexperiencehost.exe",
        ];
  return blocked.includes(surface.toLowerCase()) ? "system-ui" : undefined;
}
/** A tier is a maximum capability, never a grant by itself. */
export function grantAllows(
  tier: ComputerAppTier,
  allowTyping: boolean,
  needed: "view" | "click" | "type",
): boolean {
  if (tier === "blocked") return false;
  if (needed === "view") return true;
  if (tier === "view") return false;
  return needed === "click" || tier === "full" || allowTyping;
}

/** Prefer exact identities/names; ambiguity never implicitly adds consent candidates. */
export function selectComputerApp(
  apps: ReadonlyArray<import("@t3tools/contracts").ComputerApp>,
  query: string,
): ReadonlyArray<import("@t3tools/contracts").ComputerApp> {
  const normalized = query.trim().toLowerCase();
  const unique = [...new Map(apps.map((app) => [app.appId.toLowerCase(), app])).values()];
  const ids = unique.filter((app) => app.appId.toLowerCase() === normalized);
  if (ids.length) return ids;
  const names = unique.filter((app) => app.name.toLowerCase() === normalized);
  return names.length ? names : unique.filter((app) => app.name.toLowerCase().includes(normalized));
}

/** Consent-facing identity and the native process may impose different ceilings. */
export function restrictComputerTier(a: ComputerAppTier, b: ComputerAppTier): ComputerAppTier {
  const tiers: ReadonlyArray<ComputerAppTier> = ["blocked", "view", "click", "full"];
  return tiers[Math.min(tiers.indexOf(a), tiers.indexOf(b))] ?? "blocked";
}
