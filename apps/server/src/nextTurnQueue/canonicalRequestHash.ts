import { createHash } from "node:crypto";

import type { ClientThreadTurnStartCommand } from "@t3tools/contracts";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function canonicalRequestHash(command: ClientThreadTurnStartCommand): string {
  const attachments = command.message.attachments.map(({ dataUrl, ...attachment }) => ({
    ...attachment,
    contentDigest: createHash("sha256").update(dataUrl).digest("hex"),
  }));
  const semanticCommand = {
    ...command,
    message: {
      ...command.message,
      attachments,
    },
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(semanticCommand)))
    .digest("hex");
}
