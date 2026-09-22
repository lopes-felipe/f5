/** HTTP paths requiring backend authentication in both server and desktop. */
export const PRIVATE_BACKEND_PATH_PREFIXES = ["/attachments/", "/api/"] as const;

export function isPrivateHttpPath(pathname: string): boolean {
  return PRIVATE_BACKEND_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
