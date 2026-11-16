import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { fieldSurfaceClassName } from "../ui/input";

export function parseDisposablePathsInput(text: string): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
  ];
}

/**
 * Edits the repo-relative globs whose uncommitted changes Storage cleanup may
 * discard when it removes an inactive worktree, such as regenerated files.
 */
export function WorktreeDisposablePathsEditor(props: {
  readonly value: ReadonlyArray<string>;
  readonly disabled?: boolean;
  readonly onSave: (paths: string[]) => void;
}) {
  const savedText = props.value.join("\n");
  const [text, setText] = useState(savedText);
  useEffect(() => setText(savedText), [savedText]);
  const paths = parseDisposablePathsInput(text);
  const dirty = paths.join("\n") !== savedText;

  return (
    <div className="space-y-2">
      <textarea
        aria-label="Disposable worktree changes"
        className={cn(fieldSurfaceClassName, "min-h-20 w-full px-2 py-1.5 font-mono text-xs")}
        placeholder={"apps/web/public/mockServiceWorker.js\n**/__screenshots__/"}
        value={text}
        disabled={props.disabled}
        onChange={(event) => setText(event.target.value)}
      />
      <p className="text-muted-foreground text-xs">
        One glob per line, relative to the repository. <code>**</code> matches any folders,{" "}
        <code>*</code> matches within one folder, and a trailing <code>/</code> matches a folder and
        everything in it. A new untracked folder only matches a pattern ending in <code>/</code> or{" "}
        <code>**</code>. Storage cleanup discards matching changes when it removes an inactive
        worktree; any other change keeps the worktree.
      </p>
      <Button
        size="xs"
        variant="outline"
        disabled={props.disabled || !dirty}
        onClick={() => props.onSave(paths)}
      >
        Save disposable paths
      </Button>
    </div>
  );
}
