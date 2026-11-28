const cssWhitespace = /[ \t\n\r\f]/;
const identifier = /[-\w\u0080-\uffff]+/y;

function quotedEnd(css: string, start: number): number {
  const quote = css[start];
  for (let cursor = start + 1; cursor < css.length; cursor++) {
    if (css[cursor] === quote) return cursor;
    if (css[cursor] === "\\") {
      cursor++;
      if (css[cursor] === "\r" && css[cursor + 1] === "\n") cursor++;
    } else if (/[\n\r\f]/.test(css[cursor]!)) return -1;
  }
  return -1;
}

export function themeCssValueFetches(css: string, checkImports = false): boolean {
  for (let cursor = 0; cursor < css.length; ) {
    const char = css[cursor];
    if (char === "\\") return true;
    if (char === '"' || char === "'") {
      const end = quotedEnd(css, cursor);
      if (end < 0) return true;
      cursor = end + 1;
      continue;
    }
    if (char === "/" && css[cursor + 1] === "*") {
      const end = css.indexOf("*/", cursor + 2);
      if (end < 0) return false;
      cursor = end + 2;
      continue;
    }
    identifier.lastIndex = char === "@" ? cursor + 1 : cursor;
    const token = identifier.exec(css);
    if (!token) {
      cursor++;
      continue;
    }
    const name = token[0].toLowerCase();
    if (checkImports && char === "@" && name === "import") return true;
    cursor = identifier.lastIndex;
    while (cursor < css.length && cssWhitespace.test(css[cursor]!)) cursor++;
    if (css[cursor] !== "(") continue;
    if (name.endsWith("image-set") || name === "src" || name === "image" || name === "attr")
      return true;
    if (name !== "url") continue;
    cursor++;
    while (cursor < css.length && cssWhitespace.test(css[cursor]!)) cursor++;
    let address: string;
    if (css[cursor] === '"' || css[cursor] === "'") {
      const end = quotedEnd(css, cursor);
      if (end < 0) return true;
      address = css.slice(cursor + 1, end);
      cursor = end + 1;
      while (cursor < css.length && cssWhitespace.test(css[cursor]!)) cursor++;
      if (css[cursor] !== ")") return true;
    } else {
      const end = css.indexOf(")", cursor);
      if (end < 0) return true;
      address = css.slice(cursor, end);
      cursor = end;
    }
    if (address.includes("\\") || !/^(?:data:|#)/i.test(address)) return true;
    cursor++;
  }
  return false;
}

export function themeCssLoadsRemoteFiles(css: string): boolean {
  return themeCssValueFetches(css, true);
}
