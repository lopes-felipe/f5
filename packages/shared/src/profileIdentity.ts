import * as Path from "node:path";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { ProfileId, type ProfileRecord } from "@t3tools/contracts";

/** A stable Default identity also protects literal-default recovery from a damaged registry. */
export const fallbackDefaultProfile = (defaultStateDir: string, port = 3773): ProfileRecord => ({
  id: Schema.decodeUnknownSync(ProfileId)(
    createHash("sha256")
      .update(
        process.platform === "win32"
          ? Path.resolve(defaultStateDir).toLowerCase()
          : Path.resolve(defaultStateDir),
      )
      .digest("hex")
      .slice(0, 32),
  ),
  slug: "default",
  name: "Default",
  isDefault: true,
  status: "ready",
  port,
  createdAt: new Date(0).toISOString(),
});
