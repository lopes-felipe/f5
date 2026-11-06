import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renameWithRetry } from "./files";

const errno = (code: string) => Object.assign(new Error(code), { code });

function failingRename(codes: readonly string[]) {
  const remaining = [...codes];
  return vi.fn(async (_from: string, _to: string) => {
    const code = remaining.shift();
    if (code) throw errno(code);
  });
}

describe("renameWithRetry", () => {
  it.each(["EPERM", "EBUSY", "EACCES"])(
    "retries %s on Windows until the rename lands",
    async (code) => {
      const rename = failingRename([code, code]);
      const sleep = vi.fn(async (_ms: number) => {});

      await renameWithRetry("a", "b", { platform: "win32", rename, sleep });

      expect(rename).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls).toEqual([[200], [200]]);
    },
  );

  it("rethrows a Windows lock that outlasts the attempts", async () => {
    const rename = failingRename(Array.from({ length: 10 }, () => "EPERM"));
    const sleep = vi.fn(async (_ms: number) => {});

    await expect(
      renameWithRetry("a", "b", { platform: "win32", rename, sleep, attempts: 4 }),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(rename).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("does not retry other errors on Windows", async () => {
    const rename = failingRename(["ENOENT"]);
    const sleep = vi.fn(async (_ms: number) => {});

    await expect(
      renameWithRetry("a", "b", { platform: "win32", rename, sleep }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(["linux", "darwin"] as const)("makes one attempt on %s", async (platform) => {
    const rename = failingRename(["EPERM"]);
    const sleep = vi.fn(async (_ms: number) => {});

    await expect(renameWithRetry("a", "b", { platform, rename, sleep })).rejects.toMatchObject({
      code: "EPERM",
    });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("renames a real directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "f5-rename-"));
    try {
      await fs.mkdir(path.join(root, "from"));
      await fs.writeFile(path.join(root, "from", "file.txt"), "content");

      await renameWithRetry(path.join(root, "from"), path.join(root, "to"));

      expect(await fs.readFile(path.join(root, "to", "file.txt"), "utf8")).toBe("content");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
