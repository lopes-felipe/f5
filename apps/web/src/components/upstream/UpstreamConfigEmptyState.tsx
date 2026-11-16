import { GitMergeIcon } from "lucide-react";

const EXAMPLE = `{
  "upstream": {
    "repository": "https://github.com/<owner>/<repo>",
    "remote": "upstream",
    "branch": "main"
  }
}`;

/** Shown when no project has an `upstream` block, or the selected one is invalid. */
export function UpstreamConfigEmptyState(props: { readonly diagnostics?: ReadonlyArray<string> }) {
  return (
    <section className="mx-auto max-w-2xl space-y-4 p-8 text-sm">
      <div className="flex items-center gap-2">
        <GitMergeIcon className="size-5 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-lg font-semibold">Track an upstream repository</h2>
      </div>
      <p className="text-muted-foreground">
        Add an <code>upstream</code> block to the project's checked-in <code>f5.json</code>. F5 then
        triages new upstream commits into topics you can port, skip or watch, and records each
        decision in the repository through one rolling ledger pull request.
      </p>
      <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">{EXAMPLE}</pre>
      {props.diagnostics && props.diagnostics.length > 0 && (
        <ul role="alert" className="list-disc space-y-1 pl-5 text-destructive-foreground">
          {props.diagnostics.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground">
        See <code>docs/user/upstream-ports.md</code> for the daily flow and keyboard shortcuts.
      </p>
    </section>
  );
}
