export function themeCssValueFetches(value: string): boolean {
  if (value.includes("\\")) return true;
  const code = value.replace(
    /url\([ \t\n\f\r]*(?:"([^"\n\r\f]*)"|'([^'\n\r\f]*)'|([^)'"\n\r\f]*))[ \t\n\f\r]*\)|"[^"\n\r\f]*"|'[^'\n\r\f]*'/gi,
    (_match, double: string | undefined, single: string | undefined, bare: string | undefined) => {
      if (double === undefined && single === undefined && bare === undefined) return "";
      const address = double ?? single ?? bare ?? "";
      return /^(?:data:|#)/i.test(address) ? "" : "url(";
    },
  );
  return /(?:\burl|[\w-]*image-set|\bsrc|\bimage|\battr)\s*\(/i.test(code);
}

export function themeCssLoadsRemoteFiles(css: string): boolean {
  const code = css.replace(
    /("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')|\/\*[\s\S]*?\*\//g,
    (_token, quoted: string | undefined) => quoted ?? "",
  );
  return /@import\b/i.test(code) || themeCssValueFetches(code);
}
