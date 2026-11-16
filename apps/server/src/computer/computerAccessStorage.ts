import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { ComputerGrant } from "@t3tools/contracts";
import type { ComputerAccessStorage } from "./ComputerAccessService";

const Stored = Schema.Array(Schema.Struct({ ...ComputerGrant.fields, projectId: Schema.String }));

/** Invalid grants never prevent profile startup or silently replace the original file. */
export function computerAccessStorage(io: {
  exists: () => Promise<boolean>;
  read: () => Promise<string>;
  quarantine: (suffix: string) => Promise<void>;
  write: (contents: string) => Promise<void>;
  warn: (message: string) => void;
}): ComputerAccessStorage {
  let writable = true;
  return {
    load: async () => {
      try {
        if (!(await io.exists())) return [];
        return Schema.decodeUnknownSync(Stored)(JSON.parse(await io.read()));
      } catch {
        try {
          await io.quarantine(`corrupt-${randomUUID()}.json`);
          io.warn("Invalid computer-access.json quarantined; starting without remembered grants.");
        } catch {
          writable = false;
          io.warn("Computer access storage is unreadable; remembered grants are disabled.");
        }
        return [];
      }
    },
    save: async (grants) => {
      if (!writable)
        throw new Error("Computer access storage must be repaired before remembering grants.");
      await io.write(JSON.stringify(grants));
    },
  };
}
