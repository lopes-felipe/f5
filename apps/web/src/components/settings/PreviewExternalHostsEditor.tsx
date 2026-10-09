import { validatePreviewHostPatterns } from "@t3tools/shared/preview";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";

export function parseExternalHostsInput(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
  ];
}

/**
 * Edits the sites the F5 preview (and agents driving it) may load besides local servers.
 * `host` allows HTTPS, `*.domain` its HTTPS subdomains, `http://host` one plain-HTTP host,
 * and `*` any HTTPS site after an explicit confirmation.
 */
export function PreviewExternalHostsEditor(props: {
  readonly value: ReadonlyArray<string>;
  readonly disabled?: boolean;
  readonly onSave: (hosts: string[]) => void;
}) {
  const savedText = props.value.join("\n");
  const [text, setText] = useState(savedText);
  useEffect(() => setText(savedText), [savedText]);
  const hosts = parseExternalHostsInput(text);
  const errors = validatePreviewHostPatterns(hosts);
  const dirty = hosts.join("\n") !== savedText;

  const save = () => {
    if (errors.length > 0) return;
    if (
      hosts.includes("*") &&
      !props.value.includes("*") &&
      !window.confirm(
        "Allow the preview, and agents using it, to open any HTTPS website? Agents can then read and act on any site you are signed in to in the preview.",
      )
    ) {
      return;
    }
    props.onSave(hosts);
  };

  return (
    <div className="space-y-2">
      <textarea
        aria-label="Allowed external sites"
        className="min-h-20 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs"
        placeholder={"example.com\n*.staging.example.com\nhttp://intranet.local"}
        value={text}
        disabled={props.disabled}
        onChange={(event) => setText(event.target.value)}
      />
      {errors.length > 0 ? (
        <ul className="space-y-0.5 text-destructive text-xs" role="alert">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-xs">
          One per line. Local servers are always allowed. Agents cannot run scripts on external
          sites.
        </p>
      )}
      <Button
        size="xs"
        variant="outline"
        disabled={props.disabled || !dirty || errors.length > 0}
        onClick={save}
      >
        Save allowed sites
      </Button>
    </div>
  );
}
