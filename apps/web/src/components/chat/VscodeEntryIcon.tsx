import { memo, useMemo, useState } from "react";
import { getVscodeIconUrlForEntry } from "../../vscode-icons";
import { FileIcon, FolderIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { useRemoteFileIconsEnabled } from "~/lib/remoteFileIcons";

export const VscodeEntryIcon = memo(function VscodeEntryIcon(props: {
  pathValue: string;
  kind: "file" | "directory";
  theme: "light" | "dark";
  className?: string;
}) {
  const remoteIcons = useRemoteFileIconsEnabled();
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  const iconUrl = useMemo(
    () => getVscodeIconUrlForEntry(props.pathValue, props.kind, props.theme),
    [props.kind, props.pathValue, props.theme],
  );
  const failed = failedIconUrl === iconUrl;

  if (failed || !remoteIcons) {
    return props.kind === "directory" ? (
      <FolderIcon className={cn("size-4 text-muted-foreground", props.className)} />
    ) : (
      <FileIcon className={cn("size-4 text-muted-foreground", props.className)} />
    );
  }

  return (
    <img
      src={iconUrl}
      alt=""
      aria-hidden="true"
      className={cn("size-4 shrink-0", props.className)}
      loading="lazy"
      onError={() => setFailedIconUrl(iconUrl)}
    />
  );
});
