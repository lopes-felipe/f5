import { ExternalLinkIcon } from "lucide-react";

import { getDesktopUpdateReleaseUrl } from "./desktopUpdate.logic";
import { Button } from "./ui/button";

/** Opens the version's GitHub release, whose notes the in-app text may abridge. */
export function DesktopUpdateReleaseLink({ version }: { version: string | null | undefined }) {
  const url = getDesktopUpdateReleaseUrl(version);
  const openExternal = window.desktopBridge?.openExternal;
  if (!url || !openExternal) return null;
  return (
    <Button
      className="h-auto gap-1 px-0 text-xs text-muted-foreground hover:text-foreground"
      size="xs"
      variant="link"
      onClick={() => void openExternal(url)}
    >
      Full release notes
      <ExternalLinkIcon aria-hidden className="size-3" />
    </Button>
  );
}
