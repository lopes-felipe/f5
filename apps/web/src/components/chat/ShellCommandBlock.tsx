import { commandHighlightLanguage } from "../../lib/commandHighlighting";
import { Suspense, use, useMemo } from "react";

import { useTheme } from "../../hooks/useTheme";
import { SurfaceErrorBoundary } from "../ui/SurfaceErrorBoundary";
import { classifyCodeHighlight } from "../../lib/codeHighlightPolicy";
import { HighlightedTokens } from "./HighlightedTokens";
import { HighlightedCommandText } from "./HighlightedCommandText";
import { retryableImport } from "../../lib/retryableImport";

// Shell words wrap as a unit, so `--exclude` or a quoted string is not split
// at a hyphen; a word longer than the line still breaks anywhere.
const WORD_CLASS_NAME = "inline-block max-w-full [overflow-wrap:anywhere]";

// The shell parser loads with the first expanded command, not with the timeline.
const loadEmbeddedScripts = retryableImport(() => import("../../lib/embeddedScripts"));

function HighlightedCommand({ code, theme }: { code: string; theme: "light" | "dark" }) {
  const { embeddedScripts } = use(loadEmbeddedScripts());
  const language = commandHighlightLanguage(code);
  // Only shell syntax nests scripts; PowerShell's own grammar colors its strings.
  const embedded = useMemo(
    () => (language === "shellscript" ? embeddedScripts(code) : []),
    [code, embeddedScripts, language],
  );
  return (
    <HighlightedTokens
      code={code}
      language={language}
      embedded={embedded}
      theme={theme}
      wordClassName={WORD_CLASS_NAME}
    />
  );
}

/**
 * The command a command_execution item ran, syntax highlighted. Scripts inside
 * it, such as a `bash -lc` script or a Python heredoc, get their own grammar.
 */
export function ShellCommandBlock({ command }: { command: string }) {
  const { resolvedTheme } = useTheme();
  const code = command;
  if (!code) return null;
  // Commands too big for inline highlighting, and a failed highlighter, use the
  // lightweight colors; they then match wherever the same command is shown.
  const lightweight = <HighlightedCommandText command={code} />;
  if (classifyCodeHighlight(code) !== "inline") return lightweight;
  return (
    // The tool body sets the monospace, pre-wrapped text this sits in.
    <span className="text-foreground">
      <SurfaceErrorBoundary
        name="Command highlighting"
        fallback={lightweight}
        resetKeys={[code, resolvedTheme]}
      >
        {/* Plain while loading, so text gains color once instead of changing palette. */}
        <Suspense fallback={code}>
          <HighlightedCommand code={code} theme={resolvedTheme} />
        </Suspense>
      </SurfaceErrorBoundary>
    </span>
  );
}
