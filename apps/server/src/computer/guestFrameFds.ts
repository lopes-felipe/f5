import * as FS from "node:fs";

/**
 * A guest backend's desktop channel: `f5-guest launch` hands it main's frames on fd 3 and
 * takes the backend's on fd 4. Inherited descriptors have no FD_CLOEXEC, so every agent,
 * shell and tool the backend spawns would inherit the channel and could read main's frames
 * or write frames as this backend. Node can't set the flag on an fd, but it opens every file
 * with O_CLOEXEC, and on Linux opening `/proc/self/fd/<n>` reopens the same pipe (the guest
 * launcher makes both pipes the backend user's, so the reopen is permitted). The originals
 * are closed.
 *
 * The server entry claims them before anything else runs, so nothing started earlier
 * inherits them either, and refuses to start when it can't. What this doesn't stop: any
 * process running as the same user can still reach the backend's descriptors and
 * environment through /proc, so main treats everything on this channel as guest input.
 */
let claimed: { readonly input: number; readonly output: number } | null = null;

export function reopenCloseOnExec(
  fd: number,
  direction: "read" | "write",
  fs: Pick<typeof FS, "openSync" | "closeSync"> = FS,
): number {
  const flags =
    (direction === "read" ? FS.constants.O_RDONLY : FS.constants.O_WRONLY) |
    FS.constants.O_NONBLOCK;
  // Throws when the reopen isn't possible: the caller refuses to start rather than keep an
  // inheritable channel.
  const reopened = fs.openSync(`/proc/self/fd/${fd}`, flags);
  fs.closeSync(fd);
  return reopened;
}

/** The channel's private descriptors, claimed once. Throws where they can't be made private. */
export function claimGuestFrameFds(
  platform: NodeJS.Platform = process.platform,
  fs: Pick<typeof FS, "openSync" | "closeSync"> = FS,
): { readonly input: number; readonly output: number } {
  if (claimed) return claimed;
  if (platform !== "linux")
    throw new Error("The guest frame channel needs Linux to make its descriptors private.");
  claimed = { input: reopenCloseOnExec(3, "read", fs), output: reopenCloseOnExec(4, "write", fs) };
  return claimed;
}
