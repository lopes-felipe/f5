import { cookieScope, type ImportedCookie } from "./cookies";
const COOKIE_PAGE_HEADER_SIZE = 12,
  COOKIE_RECORD_HEADER_SIZE = 56,
  FLAG_SECURE = 1,
  FLAG_HTTP_ONLY = 4,
  APPLE_EPOCH_OFFSET_SECONDS = 978307200;
function readCString(buffer: Buffer, start: number): string {
  const end = buffer.indexOf(0, start);
  return buffer.toString("utf8", start, end === -1 ? buffer.length : end);
}

export function parseBinaryCookies(buffer: Buffer): ReadonlyArray<ImportedCookie> {
  if (buffer.length < 8 || buffer.toString("latin1", 0, 4) !== "cook") {
    throw new Error("Corrupt Safari cookie database.");
  }

  const pageCount = buffer.readUInt32BE(4);
  // Every declared structure is bounds-checked against what the file actually
  // contains, and a mismatch fails the read. `Buffer.subarray` clamps silently,
  // so accepting a short page or an overlong record would return a cookie set
  // that is quietly missing entries or carrying fields read out of the next
  // record — a partial import the user has no way to notice.
  if (8 + pageCount * 4 > buffer.length) {
    throw new Error("Corrupt Safari cookie database.");
  }
  const pageSizes: number[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    pageSizes.push(buffer.readUInt32BE(8 + index * 4));
  }

  const cookies: ImportedCookie[] = [];
  let pageStart = 8 + pageCount * 4;

  for (const pageSize of pageSizes) {
    if (pageSize < COOKIE_PAGE_HEADER_SIZE || pageStart + pageSize > buffer.length) {
      throw new Error("Corrupt Safari cookie database.");
    }
    const page = buffer.subarray(pageStart, pageStart + pageSize);
    pageStart += pageSize;

    // Page bodies switch to little-endian after the big-endian header.
    const cookieCount = page.readUInt32LE(4);
    const offsetTableEnd = COOKIE_PAGE_HEADER_SIZE + cookieCount * 4;
    if (offsetTableEnd > page.length) {
      throw new Error("Corrupt Safari cookie database.");
    }
    // Every record accepted so far, so a later offset cannot point back into
    // one of them: the page header, the offset table, and earlier records are
    // all bytes that would otherwise parse as a fabricated cookie.
    const accepted: Array<readonly [start: number, end: number]> = [];
    for (let index = 0; index < cookieCount; index += 1) {
      const cookieStart = page.readUInt32LE(8 + index * 4);
      if (cookieStart < offsetTableEnd || cookieStart + COOKIE_RECORD_HEADER_SIZE > page.length) {
        throw new Error("Corrupt Safari cookie database.");
      }
      // Bounded by the record's own length so a string offset cannot run past
      // it into the following record's bytes.
      const recordSize = page.readUInt32LE(cookieStart);
      const cookieEnd = cookieStart + recordSize;
      if (
        recordSize < COOKIE_RECORD_HEADER_SIZE ||
        cookieEnd > page.length ||
        accepted.some(([start, end]) => cookieStart < end && cookieEnd > start)
      ) {
        throw new Error("Corrupt Safari cookie database.");
      }
      accepted.push([cookieStart, cookieEnd]);
      const cookie = page.subarray(cookieStart, cookieEnd);

      const flags = cookie.readUInt32LE(8);
      const urlOffset = cookie.readUInt32LE(16);
      const nameOffset = cookie.readUInt32LE(20);
      const pathOffset = cookie.readUInt32LE(24);
      const valueOffset = cookie.readUInt32LE(28);
      const expiry = cookie.readDoubleLE(40);

      // Offsets are relative to the record; one pointing outside it would
      // otherwise read a neighbouring cookie's bytes as this one's value.
      if (
        [urlOffset, nameOffset, pathOffset, valueOffset].some(
          (offset) => offset < COOKIE_RECORD_HEADER_SIZE || offset >= cookie.length,
        )
      ) {
        throw new Error("Corrupt Safari cookie database.");
      }
      const domain = readCString(cookie, urlOffset);
      const name = readCString(cookie, nameOffset);
      const path = readCString(cookie, pathOffset);
      const value = readCString(cookie, valueOffset);
      if (domain === "" || name === "") continue;

      const secure = (flags & FLAG_SECURE) !== 0;
      const expirationDate =
        expiry > 0 ? Math.floor(expiry) + APPLE_EPOCH_OFFSET_SECONDS : undefined;

      cookies.push({
        // Safari marks domain cookies with a leading dot like the other
        // engines, so the shared scope rule applies: host-only cookies keep
        // `domain` undefined, or Electron widens them to every subdomain.
        ...cookieScope(domain, path || "/", secure),
        name,
        value,
        path: path || "/",
        secure,
        httpOnly: (flags & FLAG_HTTP_ONLY) !== 0,
        ...(expirationDate === undefined ? {} : { expirationDate }),
        // Bits 3–5 of the flags carry something SameSite-shaped, but no public
        // description of them agrees and real jars do not match any of them
        // cleanly. Lax is the modern browser default; claiming "none" would
        // widen every imported cookie's scope.
        sameSite: "lax",
      });
    }
  }

  // Safari writes an 8-byte checksum after the pages, then an optional
  // length-prefixed property list. Anything else past the declared pages —
  // in particular whole extra pages — means the page table does not describe
  // the file, and a jar the header lies about is refused rather than
  // imported with cookies silently missing.
  const trailer = buffer.length - pageStart;
  // Legal shapes: nothing, the 8-byte checksum alone, or checksum + u32
  // length + exactly that many property-list bytes.
  const validTrailer =
    trailer === 0 ||
    trailer === 8 ||
    (trailer >= 12 && trailer === 8 + 4 + buffer.readUInt32BE(pageStart + 8));
  if (!validTrailer) {
    throw new Error("Corrupt Safari cookie database.");
  }

  return cookies;
}
