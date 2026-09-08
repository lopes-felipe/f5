import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useProfileState, profileBrowserUrl } from "../profileState";
import { Popover, PopoverTrigger, PopoverPopup } from "./ui/popover";
import { Button } from "./ui/button";

export function ProfileSwitcher() {
  const [error, setError] = useState("");
  const { active, profiles, mismatch } = useProfileState();
  if (mismatch)
    return (
      <div role="alert">
        This server changed profiles.{" "}
        <button onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  if (!active) return null;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            className="no-drag rounded-full border px-2 py-1 text-xs"
            style={{ borderColor: active.accentColor }}
            aria-label="Switch profile"
          >
            {active.name}
          </button>
        }
      />
      <PopoverPopup className="w-72 space-y-2 p-3">
        <p className="text-sm font-medium">Profiles</p>
        {error && <p role="alert">{error}</p>}
        {profiles
          .filter((profile) => profile.status === "ready")
          .map((profile) => (
            <div key={profile.id} className="flex items-center justify-between gap-2 text-sm">
              <span>
                {profile.name}
                {profile.isActive ? " (active)" : ""}
              </span>
              {!profile.isActive &&
                (window.desktopBridge?.switchProfile ? (
                  <Button
                    size="sm"
                    onClick={() =>
                      void window.desktopBridge
                        ?.switchProfile?.(profile.id)
                        .catch((cause) => setError(String(cause)))
                    }
                  >
                    Open
                  </Button>
                ) : (
                  <a href={profileBrowserUrl(profile)} target="_blank" rel="noreferrer">
                    Open
                  </a>
                ))}
              <button
                aria-label={`Copy command for ${profile.name}`}
                onClick={() => void navigator.clipboard.writeText(`t3 --profile ${profile.slug}`)}
              >
                Copy command
              </button>
            </div>
          ))}
        <Link to="/settings" search={{ category: "profiles" }}>
          Manage profiles / New profile
        </Link>
      </PopoverPopup>
    </Popover>
  );
}
