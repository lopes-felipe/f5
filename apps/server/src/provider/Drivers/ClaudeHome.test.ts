import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Path } from "effect";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" }, process.env)).toBe(process.env);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        const env = yield* makeClaudeEnvironment(
          { homePath },
          {
            HOME: "/other",
            USERPROFILE: "/other",
            HOMEDRIVE: "Z:",
            HOMEPATH: "\\other",
            PATH: "executables",
          },
        );
        expect(env.HOME).toBe(resolved);
        expect(env.USERPROFILE).toBe(resolved);
        expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(resolved, ".claude"));
        expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(env.CLAUDE_CONFIG_DIR);
        expect(env.PATH).toBe("executables");
        if (/^[a-z]:/i.test(resolved)) {
          expect(env.HOMEDRIVE).toBe(resolved.slice(0, 2));
          expect(env.HOMEPATH).toBe(resolved.slice(2));
        } else {
          expect(env.HOMEDRIVE).toBeUndefined();
          expect(env.HOMEPATH).toBeUndefined();
        }
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}`,
        );
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(
          `claude:home:${resolved}`,
        );
      }),
    );
  });
});
