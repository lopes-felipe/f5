/** Windows runners need longer to load the Bun fixtures' server and web module graphs. */
export function chaosTimeout(milliseconds: number, platform = process.platform): number {
  return platform === "win32" ? milliseconds * 3 : milliseconds;
}
