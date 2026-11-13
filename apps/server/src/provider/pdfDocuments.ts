import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { ProviderResolvedAttachment } from "./Services/ProviderAdapter";

const locks = new Map<string, Promise<unknown>>();
export async function acpPdfDocuments(
  input: Parameters<typeof pdfDocuments>[0],
  embeddedContext: boolean,
) {
  if (!embeddedContext) return [];
  return (await pdfDocuments(input)).map(({ data, uri }) => ({
    type: "resource" as const,
    resource: { uri, mimeType: "application/pdf", blob: data },
  }));
}
function budgetFile(stateDir: string, sessionKey: string) {
  return path.join(
    stateDir,
    "provider-document-budgets",
    createHash("sha256").update(sessionKey).digest("hex") + ".json",
  );
}
/** Deletion is final; wait for any reservation before reclaiming its small budget record. */
export async function deletePdfDocumentBudgets(stateDir: string, threadId: string): Promise<void> {
  for (const provider of ["claude", "antigravity"]) {
    const file = budgetFile(stateDir, provider + ":" + threadId);
    await locks.get(file)?.catch(() => {});
    await fs.unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
/** Persist a conservative upper bound before delivery: retries and process loss never undercount. */
export async function pdfDocuments(input: {
  stateDir: string;
  sessionKey: string;
  baseBytes: number;
  attachments: readonly ProviderResolvedAttachment[];
}): Promise<{ data: string; uri: string }[]> {
  if (
    !input.attachments.some(
      (attachment) =>
        attachment.type === "file" &&
        attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf",
    )
  )
    return [];
  const file = budgetFile(input.stateDir, input.sessionKey);
  const prior = locks.get(file) ?? Promise.resolve();
  const operation = prior
    .catch(() => {})
    .then(async () => {
      let used = { bytes: 0, pages: 0 };
      try {
        const parsed = JSON.parse(await fs.readFile(file, "utf8"));
        if (
          !Number.isSafeInteger(parsed.bytes) ||
          parsed.bytes < 0 ||
          !Number.isSafeInteger(parsed.pages) ||
          parsed.pages < 0
        )
          throw new Error("Invalid document budget");
        used = parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return [];
      }
      const result: { data: string; uri: string }[] = [];
      for (const attachment of input.attachments) {
        if (
          attachment.type !== "file" ||
          attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() !== "application/pdf"
        )
          continue;
        const remaining = Math.min(
          20 * 1024 * 1024,
          Math.floor(((28 * 1024 * 1024 - used.bytes - input.baseBytes - 1024) * 3) / 4),
        );
        if (used.pages >= 100 || remaining <= 0) break;
        const handle = await fs.open(attachment.localPath, "r").catch(() => null);
        if (!handle) continue;
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > remaining) continue;
          const bytes = Buffer.alloc(info.size + 1);
          let offset = 0;
          while (offset < bytes.length) {
            const read = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!read.bytesRead) break;
            offset += read.bytesRead;
          }
          if (offset > remaining || offset !== info.size) continue;
          const data = bytes.subarray(0, offset);
          const pages = estimateClaudePdfPages(data);
          if (pages === null || pages + used.pages > 100) continue;
          used.pages += pages;
          used.bytes += 4 * Math.ceil(data.length / 3) + 128;
          result.push({
            data: data.toString("base64"),
            uri:
              "attachment:" +
              encodeURIComponent(attachment.id) +
              "/" +
              encodeURIComponent(attachment.name),
          });
        } finally {
          await handle.close();
        }
      }
      if (!result.length) return [];
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + "." + randomUUID();
      try {
        await fs.writeFile(temporary, JSON.stringify(used), { mode: 0o600, flag: "wx" });
        await fs.rename(temporary, file);
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
      return result;
    });
  locks.set(file, operation);
  try {
    return await operation.catch(() => []);
  } finally {
    if (locks.get(file) === operation) locks.delete(file);
  }
}

export const estimateClaudePdfPages = (bytes: Buffer): number | null => {
  if (bytes.length > 20 * 1024 * 1024 || bytes.subarray(0, 5).toString() !== "%PDF-") return null;
  if (!bytes.subarray(-1024).includes("%%EOF")) return null;
  let pages = 0;
  let count = 0;
  let catalog = false;
  let pageTree = false;
  let previous = "";
  const delimiter = (byte: number) =>
    byte <= 32 || "()<>[]{}/%".includes(String.fromCharCode(byte));
  for (let i = 0; i < bytes.length; ) {
    const byte = bytes[i]!;
    if (byte === 37) {
      while (i < bytes.length && bytes[i] !== 10 && bytes[i] !== 13) i++;
      continue;
    }
    if (byte <= 32) {
      i++;
      continue;
    }
    if (previous === "/Type" && byte !== 47) return null;
    if (previous === "/Kids") {
      if (byte !== 91) return null;
      previous = "";
    }
    if (byte === 40) {
      let depth = 1;
      for (i++; i < bytes.length && depth > 0; i++) {
        if (bytes[i] === 92) i++;
        else if (bytes[i] === 40) depth++;
        else if (bytes[i] === 41) depth--;
      }
      if (depth !== 0) return null;
      previous = "";
      continue;
    }
    if (byte === 60 && bytes[i + 1] !== 60) {
      i = bytes.indexOf(62, i + 1);
      if (i < 0) return null;
      i++;
      previous = "";
      continue;
    }
    if (byte === 60 && bytes[i + 1] === 60) {
      i += 2;
      previous = "";
      continue;
    }
    if (delimiter(byte) && byte !== 47) {
      i++;
      continue;
    }
    const start = i++;
    while (i < bytes.length && !delimiter(bytes[i]!)) i++;
    if (i - start > 64) return null;
    const token = bytes.toString("latin1", start, i);
    if (token.includes("#") || ["/ObjStm", "/XRef", "/Encrypt", "/Prev"].includes(token))
      return null;
    if (token === "stream") {
      i = bytes.indexOf("endstream", i);
      if (i < 0) return null;
      i += 9;
      previous = "";
      continue;
    }
    if (previous === "/Type") {
      if (token === "/Page") pages++;
      if (token === "/Catalog") catalog = true;
      if (token === "/Pages") pageTree = true;
    }
    if (previous === "/Count") {
      if (!/^[1-9]\d{0,8}$/.test(token)) return null;
      let next = i;
      while (next < bytes.length) {
        if (bytes[next]! <= 32) next++;
        else if (bytes[next] === 37) {
          while (next < bytes.length && bytes[next] !== 10 && bytes[next] !== 13) next++;
        } else break;
      }
      // A second scalar is an indirect reference, not a direct page count.
      if (next < bytes.length && !delimiter(bytes[next]!)) return null;
      count = Math.max(count, Number(token));
    }
    previous = token;
  }
  return catalog && pageTree && pages > 0 && count === pages ? pages : null;
};
