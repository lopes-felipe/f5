import { Effect, Path } from "effect";
import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { PI_F5_MCP_EXTENSION_FILENAME, PI_F5_MCP_EXTENSION_SOURCE } from "./mcpExtensionSource.ts";

/** Only the profile-owned cache is passed here. Atomic replacement never follows a destination link. */
export const materializePiMcpExtension = (cacheDir: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const dest = path.join(cacheDir, PI_F5_MCP_EXTENSION_FILENAME);
    yield* writeFileStringAtomically({ filePath: dest, contents: PI_F5_MCP_EXTENSION_SOURCE });
    return dest;
  });
