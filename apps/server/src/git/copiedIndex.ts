/**
 * The whole-second timestamp a copied index keeps, so files edited in its own second stay racy
 * for Git. Node already truncates the index mtime to milliseconds, so flooring is enough;
 * subtracting another millisecond would also make every file from the preceding second racy
 * and reread.
 */
export function copiedIndexTimestampSeconds(mtime: Date): number {
  return Math.floor(mtime.getTime() / 1000);
}
