import { lexShellCommand, isShellCommandSeparatorToken } from "@t3tools/shared/commandSummary";
import {
  getSharedHighlighter,
  type DiffsHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";
import { PREFERRED_HIGHLIGHTER, resolveDiffThemeName } from "./diffRendering";

const promises = new Map<string, Promise<DiffsHighlighter>>();

/** Stable promises for React Suspense, sharing the diff/Markdown highlighter. */
export function getSyntaxHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = promises.get(language);
  if (cached) return cached;
  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
  });
  promises.set(language, promise);
  if (promises.size > 64) promises.delete(promises.keys().next().value!);
  return promise;
}

const POWERSHELL_VERBS = new Set(
  "Add Approve Assert Backup Block Build Checkpoint Clear Close Compare Complete Compress Confirm Connect Convert ConvertFrom ConvertTo Copy Debug Deny Deploy Disable Disconnect Dismount Edit Enable Enter Exit Expand Export Find ForEach Format Get Grant Group Hide Import Initialize Install Invoke Join Limit Lock Measure Merge Mount Move New Open Optimize Out Ping Pop Protect Publish Push Read Receive Redo Register Remove Rename Repair Request Reset Resize Resolve Restart Restore Resume Revoke Save Search Select Send Set Show Skip Sort Split Start Step Stop Submit Suspend Switch Sync Tee Test Trace Unblock Undo Uninstall Unlock Unprotect Unpublish Unregister Update Use Wait Watch Where Write".split(
    " ",
  ),
);

export function commandHighlightLanguage(command: string): "powershell" | "shellscript" {
  const program = /^(?:&\s*)?(?:"([^"]*)"|'([^']*)'|(\S+))/u.exec(command.trim());
  const name = (program?.[1] ?? program?.[2] ?? program?.[3] ?? "")
    .split(/[\\/]/u)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.exe$/u, "");
  if (name === "powershell" || name === "pwsh" || /^&\s*\S/u.test(command.trim())) {
    return "powershell";
  }
  const isPowerShellStatement = (statement: string) => {
    const text = statement.trim();
    const verb = /^([A-Z][a-z]+(?:[A-Z][a-z]+)?)-[A-Z][A-Za-z]*(?:\s|$)/u.exec(text)?.[1];
    return (
      /^\$(?:env|global|local|script):/iu.test(text) ||
      /^\$[A-Za-z_]\w*\s+=/u.test(text) ||
      (verb !== undefined && POWERSHELL_VERBS.has(verb))
    );
  };
  let statement = "";
  for (const token of lexShellCommand(command)) {
    if (isShellCommandSeparatorToken(token) || (!token.trim() && token.includes("\n"))) {
      if (isPowerShellStatement(statement)) return "powershell";
      statement = "";
      continue;
    }
    statement += token;
  }
  return isPowerShellStatement(statement) ? "powershell" : "shellscript";
}
