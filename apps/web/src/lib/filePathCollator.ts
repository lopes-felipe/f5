// `localeCompare` with options resolves the locale on every call, which
// dominates sorting a large diff's files. These collators order the same way.

const numericBaseCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const numericCollator = new Intl.Collator(undefined, { numeric: true });

/** `a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })`. */
export const compareFilePaths = (a: string, b: string): number => numericBaseCollator.compare(a, b);

/** `a.localeCompare(b, undefined, { numeric: true })`. */
export const compareFilePathsCaseSensitive = (a: string, b: string): number =>
  numericCollator.compare(a, b);
