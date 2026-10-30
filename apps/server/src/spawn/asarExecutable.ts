/**
 * Native processes cannot traverse Electron's virtual ASAR filesystem. Resolve
 * their on-disk sibling before passing a path to spawn or a shell wrapper.
 */
export function resolveAsarExecutablePath(executable: string): string {
  return executable.replace(/(^|[\\/])([^\\/]+\.asar)(?=[\\/])/, "$1$2.unpacked");
}
