import { createHash } from "node:crypto";

import type { ClientThreadTurnStartCommand, ThreadTurnStartCommand } from "@t3tools/contracts";

import { canonicalJsonHash } from "../canonicalJsonHash.ts";

export function canonicalRequestHash(
  command: ClientThreadTurnStartCommand | ThreadTurnStartCommand,
): string {
  const attachments = command.message.attachments.map((entry) => {
    if (entry.type === "upload" || !("dataUrl" in entry)) return entry;
    const { dataUrl, ...attachment } = entry;
    return { ...attachment, contentDigest: createHash("sha256").update(dataUrl).digest("hex") };
  });
  const semanticCommand = {
    ...command,
    message: {
      ...command.message,
      attachments,
    },
  };
  return canonicalJsonHash(semanticCommand);
}
