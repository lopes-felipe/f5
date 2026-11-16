/** The parser's list-item start excludes blockquote prefixes. */
export function taskMarkerOffset(markdown: string, start: number): number | null {
  const line = markdown.slice(start).split("\n", 1)[0] ?? "";
  const match = /^(?:\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/.exec(line);
  return match?.[1] ? start + line.indexOf(match[1]) : null;
}

export function setTaskChecked(body: string, offset: number, checked: boolean): string {
  if (!Number.isInteger(offset) || offset < 0 || !/^\[[ xX]\]/.test(body.slice(offset)))
    return body;
  return body.slice(0, offset + 1) + (checked ? "x" : " ") + body.slice(offset + 2);
}
