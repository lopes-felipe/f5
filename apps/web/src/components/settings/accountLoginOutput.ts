// Login output arrives in arbitrary PTY chunks. Do not offer a URL until its
// delimiter arrives, or a click can open a truncated OAuth state/challenge.
export function accountLoginOutput(output: string): { text: string; urls: string[] } {
  const text = output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const urls = [...text.matchAll(/https:\/\/[^\s\x00-\x1f\x7f<>]+/g)]
    .filter((match) => /\s/.test(text[match.index + match[0].length] ?? ""))
    .map((match) => match[0])
    .filter((candidate) => {
      try {
        return new URL(candidate).protocol === "https:";
      } catch {
        return false;
      }
    });
  return { text, urls: [...new Set(urls)] };
}
