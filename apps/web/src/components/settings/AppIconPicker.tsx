import { APP_ICON_IDS } from "@t3tools/contracts";

import { APP_ICON_LABELS, appIconUrl, useAppIcon } from "../../appIcon";
import { cn, isMacPlatform } from "../../lib/utils";

/** Where the choice shows, which depends on what the operating system lets an app change. */
export function appIconHelpText(isDesktopApp: boolean, platform: string): string {
  if (!isDesktopApp) return "Shown in the sidebar and the browser tab.";
  return isMacPlatform(platform)
    ? "Shown in the Dock, the app switcher and the sidebar. Finder, Launchpad and notifications keep the default icon."
    : "Shown in the taskbar while F5 is open, and in the sidebar.";
}

export function AppIconPicker() {
  const { id, setId } = useAppIcon();
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4">
        <h2 className="text-sm font-medium text-foreground">App icon</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {appIconHelpText(Boolean(window.desktopBridge?.appIcon), navigator.platform)}
        </p>
      </div>
      <div
        className="grid grid-cols-3 gap-2 sm:grid-cols-5"
        role="radiogroup"
        aria-label="App icon"
      >
        {APP_ICON_IDS.map((option) => {
          const selected = id === option;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              className={cn(
                "flex flex-col items-center gap-2 rounded-lg border px-3 py-3 transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                selected
                  ? "border-primary/60 bg-primary/10 text-foreground"
                  : "border-border bg-background text-muted-foreground hover:bg-accent",
              )}
              onClick={() => setId(option)}
            >
              <img
                src={appIconUrl(option, 256)}
                alt=""
                width={56}
                height={56}
                className="size-14"
                draggable={false}
              />
              <span className="text-xs font-medium">{APP_ICON_LABELS[option]}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
