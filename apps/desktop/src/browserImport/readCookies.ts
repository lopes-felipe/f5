import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromiumKey, cookieScope, decryptChromium, type ImportedCookie } from "./cookies";
import { parseBinaryCookies } from "./safari";
import type { SourceProfile } from "./sources";

async function command(file: string, args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      { timeout: 15_000, maxBuffer: 128 * 1024, windowsHide: true },
      (error, stdout) =>
        error
          ? reject(new Error("The OS credential store is unavailable or permission was denied."))
          : resolve(stdout.trim()),
    ),
  );
}
async function windowsUnprotect(bytes: Buffer): Promise<Buffer> {
  const encoded = bytes.toString("base64");
  const script = `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${encoded}'), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  return Buffer.from(
    await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]),
    "base64",
  );
}
async function keys(
  profile: SourceProfile,
  platform: NodeJS.Platform,
): Promise<{ v10?: Buffer; v11?: Buffer }> {
  if (platform === "darwin")
    return {
      v10: chromiumKey(
        await command("/usr/bin/security", [
          "find-generic-password",
          "-w",
          "-s",
          profile.service!,
          "-a",
          profile.account!,
        ]),
        platform,
      ),
    };
  if (platform === "linux") {
    const secret = await command("secret-tool", [
      "lookup",
      "application",
      profile.application!,
    ]).catch(() => undefined);
    return {
      v10: chromiumKey("peanuts", platform),
      ...(secret ? { v11: chromiumKey(secret, platform) } : {}),
    };
  }
  if (platform === "win32") {
    const state = JSON.parse(await readFile(path.join(profile.root, "Local State"), "utf8")) as {
      os_crypt?: { encrypted_key?: string };
    };
    const encrypted = Buffer.from(state.os_crypt?.encrypted_key ?? "", "base64");
    if (encrypted.toString("ascii", 0, 5) !== "DPAPI")
      throw new Error("App-bound or unsupported browser encryption.");
    return { v10: await windowsUnprotect(encrypted.subarray(5)) };
  }
  throw new Error("Unsupported browser platform.");
}
export async function readCookies(
  profile: SourceProfile,
  signal: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<{ cookies: ImportedCookie[]; skipped: number }> {
  const directory = await mkdtemp(path.join(tmpdir(), "f5-cookie-import-"));
  const cookies: ImportedCookie[] = [];
  let skipped = 0;
  try {
    signal.throwIfAborted();
    if ((await stat(profile.database)).size > 128 * 1024 * 1024)
      throw new Error("The source cookie database exceeds the import limit.");
    const target = path.join(directory, "cookies");
    await copyFile(profile.database, target);
    if (profile.engine === "safari")
      return { cookies: [...parseBinaryCookies(await readFile(target))], skipped: 0 };
    // Copy the WAL as well; the source is never opened or modified. A corrupt or
    // inconsistent snapshot fails as a whole and the unpublished stage is cleared.
    for (const suffix of ["-wal", "-shm"]) {
      const size = await stat(profile.database + suffix).then(
        (value) => value.size,
        (error) => {
          if (error.code === "ENOENT") return 0;
          throw new Error("Source database permission denied.");
        },
      );
      if (size > 128 * 1024 * 1024)
        throw new Error("Source database journal exceeds the import limit.");

      await copyFile(profile.database + suffix, target + suffix).catch((error) => {
        if (error.code !== "ENOENT")
          throw new Error("The source database is locked or inaccessible.");
      });
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(target, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout=1000");
      if (profile.engine === "firefox") {
        const rows = db
          .prepare(
            "SELECT host,name,value,path,expiry,isSecure,isHttpOnly,sameSite,originAttributes FROM moz_cookies LIMIT 100001",
          )
          .all();
        if (rows.length > 100000) throw new Error("Cookie import limit exceeded.");
        for (const [index, row] of rows.entries()) {
          if (index % 100 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
          signal.throwIfAborted();
          if (String(row.originAttributes ?? "")) {
            skipped++;
            continue;
          }
          const secure = Boolean(row.isSecure);
          const cookiePath = String(row.path || "/");
          cookies.push({
            ...cookieScope(String(row.host), cookiePath, secure),
            name: String(row.name),
            value: String(row.value),
            path: cookiePath,
            secure,
            httpOnly: Boolean(row.isHttpOnly),
            sameSite: row.sameSite === 2 ? "strict" : row.sameSite === 1 ? "lax" : "no_restriction",
            ...(Number(row.expiry) > 0 ? { expirationDate: Number(row.expiry) } : {}),
          });
        }
      } else {
        const columns = db
          .prepare("PRAGMA table_info(cookies)")
          .all()
          .map((row) => String(row.name));
        const partition = columns.includes("top_frame_site_key")
          ? "top_frame_site_key"
          : "'' AS top_frame_site_key";
        const version = Number(
          db.prepare("SELECT value FROM meta WHERE key='version'").get()?.value ?? 0,
        );
        const rows = db
          .prepare(
            `SELECT host_key,name,value,encrypted_value,path,expires_utc/1000000.0 AS expiry,is_secure,is_httponly,samesite,${partition} FROM cookies LIMIT 100001`,
          )
          .all();
        if (rows.length > 100000) throw new Error("Cookie import limit exceeded.");
        const keyMaterial = rows.some(
          (row) => !row.value && (row.encrypted_value as Uint8Array)?.length,
        )
          ? await keys(profile, platform)
          : {};
        for (const [index, row] of rows.entries()) {
          if (index % 100 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
          signal.throwIfAborted();
          if (row.top_frame_site_key) {
            skipped++;
            continue;
          }
          const secure = Boolean(row.is_secure),
            cookiePath = String(row.path || "/"),
            host = String(row.host_key);
          try {
            const encrypted = Buffer.from(row.encrypted_value as Uint8Array);
            const value = row.value
              ? String(row.value)
              : platform === "win32" &&
                  !["v10", "v11", "v20"].includes(encrypted.toString("ascii", 0, 3))
                ? (await windowsUnprotect(encrypted)).toString("utf8")
                : decryptChromium(encrypted, host, version, keyMaterial, platform);
            cookies.push({
              ...cookieScope(host, cookiePath, secure),
              name: String(row.name),
              value,
              path: cookiePath,
              secure,
              httpOnly: Boolean(row.is_httponly),
              sameSite:
                row.samesite === 2
                  ? "strict"
                  : row.samesite === 1
                    ? "lax"
                    : row.samesite === 0
                      ? "no_restriction"
                      : "unspecified",
              ...(Number(row.expiry) > 0
                ? { expirationDate: Number(row.expiry) - 11644473600 }
                : {}),
            });
          } catch {
            skipped++;
          }
        }
      }
      return { cookies, skipped };
    } finally {
      db.close();
    }
  } catch (error) {
    if (signal.aborted) throw new Error("Import canceled.");
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      code === "EACCES" || code === "EPERM"
        ? "Browser permission denied. Safari requires Full Disk Access."
        : "Cookie source could not be read. Close the browser, check credential-store permissions and retry. App-bound encryption is unsupported.",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
