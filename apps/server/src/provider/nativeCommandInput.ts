/**
 * The leading `/name` of input that reads as a provider command. A path such as
 * `/Users/me/app.ts` is a prompt: the name must end at whitespace or the end of
 * the input, never at another `/`.
 */
export function leadingSlashCommandName(text: string): string | undefined {
  return /^\/([A-Za-z0-9][\w.:-]*)(?=\s|$)/.exec(text.trimStart())?.[1];
}
