import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  PROJECT_READ_FILE_MAX_SIZE,
  type ProjectWriteFileInput,
  type ProjectWriteFileResult,
} from "@t3tools/contracts";
import { acquireInstanceLock, ProfileBusyError } from "./profiles/InstanceLock";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, target: string) => {
  const relative = Path.relative(root, target);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${Path.sep}`) ||
    Path.isAbsolute(relative)
  )
    throw new Error("Workspace file path must stay within the project root.");
};
const statOrMissing = (file: string) =>
  FS.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

/** Connection-owned exclusion is shared by every profile; temp files stay on the destination volume. */
export async function writeWorkspaceFile(
  input: ProjectWriteFileInput,
  locksRoot: string,
  operations: Pick<typeof FS, "link"> = FS,
): Promise<ProjectWriteFileResult> {
  if (Path.isAbsolute(input.relativePath))
    throw new Error("Workspace file path must be relative to the project root.");
  const root = await FS.realpath(input.cwd);
  const requested = Path.resolve(root, input.relativePath);
  inside(root, requested);
  // Authorize the closest existing parent before creating any directories.
  let parent = Path.dirname(requested);
  while (!(await statOrMissing(parent))) parent = Path.dirname(parent);
  const realAncestor = await FS.realpath(parent);
  if (realAncestor !== root) inside(root, realAncestor);
  await FS.mkdir(Path.dirname(requested), { recursive: true });
  const canonicalParent = await FS.realpath(Path.dirname(requested));
  if (canonicalParent !== root) inside(root, canonicalParent);
  const destination = Path.join(canonicalParent, Path.basename(requested));
  const initial = await statOrMissing(destination);
  if (initial?.isSymbolicLink() || (initial && !initial.isFile()))
    throw new Error("Saving symlinks or non-regular files is unsupported.");
  // Probe the destination volume rather than assuming all macOS volumes fold case.
  const probe = Path.join(canonicalParent, `.f5-case-${randomUUID().toLowerCase()}`);
  let caseInsensitive = false;
  await FS.writeFile(probe, "", { flag: "wx", mode: 0o600 });
  try {
    caseInsensitive =
      (await statOrMissing(Path.join(canonicalParent, Path.basename(probe).toUpperCase()))) !==
      null;
  } finally {
    await FS.unlink(probe);
  }
  const identity = caseInsensitive ? destination.normalize("NFD").toLowerCase() : destination;
  const lockPath = Path.join(locksRoot, "file-writes", `${hash(Buffer.from(identity))}.sqlite`);
  const deadline = Date.now() + 30_000;
  let lock: Awaited<ReturnType<typeof acquireInstanceLock>>;
  for (;;) {
    try {
      lock = await acquireInstanceLock(lockPath);
      break;
    } catch (error) {
      if (!(error instanceof ProfileBusyError)) throw error;
      if (Date.now() >= deadline)
        throw new Error("Timed out waiting for another F5 writer to finish saving this file.", {
          cause: error,
        });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  let temporary: string | undefined;
  try {
    const current = await statOrMissing(destination);
    if (current?.isSymbolicLink() || (current && !current.isFile()))
      throw new Error("Saving symlinks or non-regular files is unsupported.");
    const currentBytes =
      current && current.size <= PROJECT_READ_FILE_MAX_SIZE ? await FS.readFile(destination) : null;
    // A null hash means missing or too large to read safely, not necessarily absent.
    const currentHash = currentBytes ? hash(currentBytes) : null;
    const conflict = (): ProjectWriteFileResult => ({
      conflict: true,
      relativePath: input.relativePath,
      currentContentSha256: currentHash,
    });
    if (
      input.condition.type === "create"
        ? current !== null
        : !current || currentHash !== input.condition.contentSha256
    )
      return conflict();
    if (
      currentBytes &&
      (currentBytes.includes(0) || !Buffer.from(currentBytes.toString("utf8")).equals(currentBytes))
    )
      throw new Error("Saving unsupported binary content is not allowed.");
    const bytes = Buffer.from(input.contents, "utf8");
    if (bytes.length > PROJECT_READ_FILE_MAX_SIZE || bytes.includes(0))
      throw new Error("Saving truncated or unsupported file content is not allowed.");
    temporary = Path.join(canonicalParent, `.f5-write-${randomUUID()}.tmp`);
    const handle = await FS.open(temporary, "wx", current ? current.mode & 0o777 : 0o666);
    try {
      await handle.writeFile(bytes);
      if (current) await handle.chmod(current.mode & 0o777);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (input.condition.type === "create") {
      try {
        await operations.link(temporary, destination);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          const appeared = await statOrMissing(destination);
          const bytes =
            appeared?.isFile() && appeared.size <= PROJECT_READ_FILE_MAX_SIZE
              ? await FS.readFile(destination)
              : null;
          return {
            conflict: true,
            relativePath: input.relativePath,
            currentContentSha256: bytes ? hash(bytes) : null,
          };
        }
        if (code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EPERM" || code === "EXDEV")
          throw new Error(
            "Atomic create is unsupported on this filesystem (hard links required).",
            { cause: error },
          );
        throw error;
      }
    } else {
      const latest = await statOrMissing(destination);
      if (!latest?.isFile() || latest.isSymbolicLink() || latest.size > PROJECT_READ_FILE_MAX_SIZE)
        return conflict();
      const latestHash = hash(await FS.readFile(destination));
      if (latestHash !== input.condition.contentSha256)
        return {
          conflict: true,
          relativePath: input.relativePath,
          currentContentSha256: latestHash,
        };
      await FS.rename(temporary, destination);
      temporary = undefined;
    }
    return {
      relativePath: Path.relative(root, destination).split(Path.sep).join("/"),
      byteLength: bytes.length,
      contentSha256: hash(bytes),
    };
  } finally {
    try {
      if (temporary) await FS.unlink(temporary);
    } finally {
      lock.release();
    }
  }
}
