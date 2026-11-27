import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { APP_ICON_IDS, AppIconId } from "@t3tools/contracts";
import { Schema } from "effect";

import { APP_ICON_LABELS, appIconUrl, useAppIcon } from "../../appIcon";
import { cn, isMacPlatform, isWindowsPlatform } from "../../lib/utils";
import { RadioGroup } from "../ui/radio-group";

const isAppIconId = Schema.is(AppIconId);

/** Where the choice shows, which depends on what the operating system lets an app change. */
export function appIconHelpText(isDesktopApp: boolean, platform: string): string {
  if (!isDesktopApp) return "Shown in the sidebar and the browser tab.";
  if (isMacPlatform(platform))
    return "Shown in the Dock, the app switcher and the sidebar. Finder, Launchpad and notifications keep the default icon.";
  if (isWindowsPlatform(platform))
    return "Shown in the taskbar while F5 is open, and in the sidebar.";
  // GNOME's dash and similar launchers draw the icon of the installed .desktop entry.
  return "Shown in the sidebar. Some Linux desktops also show it in the taskbar while F5 is open.";
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
      <RadioGroup
        aria-label="App icon"
        value={id}
        onValueChange={(value) => {
          if (isAppIconId(value)) setId(value);
        }}
        className="grid grid-cols-3 gap-2 sm:grid-cols-5"
      >
        {APP_ICON_IDS.map((option) => (
          <RadioPrimitive.Root
            key={option}
            value={option}
            className={cn(
              "flex cursor-pointer flex-col items-center gap-2 rounded-lg border px-3 py-3 outline-none transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring",
              id === option
                ? "border-primary/60 bg-primary/10 text-foreground"
                : "border-border bg-background text-muted-foreground hover:bg-accent",
            )}
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
          </RadioPrimitive.Root>
        ))}
      </RadioGroup>
    </section>
  );
}
