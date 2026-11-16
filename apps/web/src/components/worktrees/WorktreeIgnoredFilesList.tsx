import type { WorktreesInspectResult } from "@t3tools/contracts";

export function WorktreeIgnoredFilesList({
  files,
}: {
  files: NonNullable<WorktreesInspectResult["ignoredFiles"]>;
}) {
  if (files.entries.length === 0 && !files.truncated) return null;
  return (
    <div className="space-y-2">
      <p>Ignored files and folders in this checkout:</p>
      <ul
        aria-label="Ignored files and folders"
        className="max-h-48 overflow-y-auto rounded border p-2"
      >
        {files.entries.map((entry) => (
          <li key={entry} className="break-all whitespace-pre-wrap">
            <code>{entry}</code>
          </li>
        ))}
      </ul>
      {files.truncated && (
        <p className="text-destructive">
          The ignored-file list is incomplete. Removal is blocked until every path can be reviewed.
        </p>
      )}
    </div>
  );
}
