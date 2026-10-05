import type { ThreadId } from "@t3tools/contracts";
import { useRightPanelStore } from "../rightPanelStore";
export function FileBreadcrumbs({ path, threadId }: { path: string; threadId?: ThreadId }) {
  const parts = path.replaceAll("\\", "/").split("/");
  return (
    <nav
      aria-label="File location"
      className="flex min-w-0 flex-wrap items-center gap-1 text-2xs text-muted-foreground"
    >
      {parts.map((part, index) => (
        <span key={parts.slice(0, index + 1).join("/")}>
          {index > 0 && <span aria-hidden="true"> / </span>}
          {threadId && index < parts.length - 1 ? (
            <button
              className="hover:underline"
              onClick={() =>
                useRightPanelStore
                  .getState()
                  .openDirectory(threadId, parts.slice(0, index + 1).join("/"))
              }
            >
              {part}
            </button>
          ) : (
            <span>{part}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
