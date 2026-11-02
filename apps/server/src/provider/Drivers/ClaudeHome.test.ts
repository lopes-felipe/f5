import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import {
  claudeAccountUsageIdentity,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  makeClaudeProcessEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude process entrypoint", () => {
    it.effect("honors Windows instance env case and ProgramData managed settings", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = {
          USERPROFILE: "/isolated",
          PROGRAMDATA: "/program-data",
          claude_code_entrypoint: "host",
        };
        const instance = [{ name: "claude_code_entrypoint", value: "instance", sensitive: false }];
        const resolve = (managed: string) =>
          makeClaudeProcessEnvironment({ homePath: "" }, base, instance, "win32").pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readFileString: (file) =>
                Effect.succeed(
                  file === path.join("/program-data", "ClaudeCode", "managed-settings.json")
                    ? managed
                    : "{}",
                ),
            }),
          );
        const environment = yield* resolve("{}");
        expect(environment.CLAUDE_CODE_ENTRYPOINT).toBe("instance");
        expect(environment.claude_code_entrypoint).toBeUndefined();
        expect(
          (yield* resolve('{"env":{"CLAUDE_CODE_ENTRYPOINT":"managed"}}')).CLAUDE_CODE_ENTRYPOINT,
        ).toBe("managed");
      }),
    );

    for (const scenario of [
      { name: "defaults without an inherited identifier", expected: "t3-code" },
      { name: "replaces the host identifier", host: "claude-desktop", expected: "t3-code" },
      {
        name: "honors instance env",
        host: "claude-desktop",
        instance: "instance",
        expected: "instance",
      },
      {
        name: "honors user settings over instance env",
        instance: "instance",
        user: '{"env":{"CLAUDE_CODE_ENTRYPOINT":"user"}}',
        expected: "user",
      },
      {
        name: "honors managed settings over user settings",
        instance: "instance",
        user: '{"env":{"CLAUDE_CODE_ENTRYPOINT":"user"}}',
        managed: '{"env":{"CLAUDE_CODE_ENTRYPOINT":"managed"}}',
        expected: "managed",
      },
      {
        name: "accepts lenient settings JSON",
        user: '{/* comment */"env":{"CLAUDE_CODE_ENTRYPOINT":"custom",},}',
        expected: "custom",
      },
      {
        name: "ignores malformed settings",
        instance: "instance",
        user: "{invalid",
        expected: "instance",
      },
      {
        name: "ignores non-string settings values",
        user: '{"env":{"CLAUDE_CODE_ENTRYPOINT":42}}',
        expected: "t3-code",
      },
      {
        name: "falls back when the final settings value is empty",
        instance: "instance",
        user: '{"env":{"CLAUDE_CODE_ENTRYPOINT":"user"}}',
        managed: '{"env":{"CLAUDE_CODE_ENTRYPOINT":""}}',
        expected: "instance",
      },
      {
        name: "keeps user overrides when managed settings omit the identifier",
        user: '{"env":{"CLAUDE_CODE_ENTRYPOINT":"user"}}',
        managed: '{"env":{"OTHER":"value"}}',
        expected: "user",
      },
    ]) {
      it.effect(scenario.name, () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const homePath = path.resolve("/profiles/claude");
          const files: Record<string, string | undefined> = {
            [path.join(homePath, ".claude", "settings.json")]: scenario.user,
            "/etc/claude-code/managed-settings.json": scenario.managed,
          };
          const reads: string[] = [];
          const base = {
            HOME: "/host",
            CLAUDE_CONFIG_DIR: "/host/.claude",
            CLAUDE_CODE_ENTRYPOINT: scenario.host,
            KEEP: "1",
            F5_AGENT_PROCESS: "1",
          };
          const environment = yield* makeClaudeProcessEnvironment(
            { homePath },
            base,
            scenario.instance === undefined
              ? undefined
              : [{ name: "CLAUDE_CODE_ENTRYPOINT", value: scenario.instance, sensitive: false }],
            "linux",
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readFileString: (file) => {
                reads.push(file);
                return files[file] === undefined
                  ? fs.readFileString(path.join(homePath, "missing-settings.json"))
                  : Effect.succeed(files[file]!);
              },
            }),
          );
          expect(environment).toMatchObject({
            CLAUDE_CODE_ENTRYPOINT: scenario.expected,
            CLAUDE_CONFIG_DIR: path.join(homePath, ".claude"),
            KEEP: "1",
            F5_AGENT_PROCESS: "1",
          });
          expect(reads).toEqual(Object.keys(files));
          expect(base.CLAUDE_CODE_ENTRYPOINT).toBe(scenario.host);
        }),
      );
    }

    it.effect("reads the instance config directory when homePath is unset", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const files: string[] = [];
        const environment = yield* makeClaudeProcessEnvironment(
          { homePath: "" },
          { HOME: "/isolated", CLAUDE_CONFIG_DIR: "/isolated/config" },
          undefined,
          "linux",
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (file) => {
              files.push(file);
              return Effect.succeed(
                file === path.resolve("/isolated/config/settings.json")
                  ? '{"env":{"CLAUDE_CODE_ENTRYPOINT":"isolated"}}'
                  : "{}",
              );
            },
          }),
        );
        expect(environment.CLAUDE_CODE_ENTRYPOINT).toBe("isolated");
        expect(files[0]).toBe(path.resolve("/isolated/config/settings.json"));
      }),
    );
  });

  describe("Claude home resolution", () => {
    it.effect(
      "keeps the macOS login keychain home while separating managed Claude config and keychain identities",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const first = yield* makeClaudeEnvironment(
            { homePath: "/profiles/work/claude" },
            { HOME: "/fake", F5_PROFILE_ISOLATED: "1" },
            "darwin",
          );
          const second = yield* makeClaudeEnvironment(
            { homePath: "/profiles/personal/claude" },
            { HOME: "/fake", F5_PROFILE_ISOLATED: "1" },
            "darwin",
          );
          expect(first.HOME).toBe(NodeOS.homedir());
          expect(second.HOME).toBe(NodeOS.homedir());
          expect(first.CLAUDE_CONFIG_DIR).toBe(path.resolve("/profiles/work/claude", ".claude"));
          expect(first.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(first.CLAUDE_CONFIG_DIR);
          expect(second.CLAUDE_CONFIG_DIR).not.toBe(first.CLAUDE_CONFIG_DIR);
          const legacy = yield* makeClaudeEnvironment({ homePath: "/custom" }, {}, "darwin");
          expect(legacy.HOME).toBe(path.resolve("/custom"));
          const linux = yield* makeClaudeEnvironment(
            { homePath: "/custom" },
            { F5_PROFILE_ISOLATED: "1" },
            "linux",
          );
          expect(linux.HOME).toBe(path.resolve("/custom"));
        }),
    );
    it.effect("changes the usage history identity when only the configured home changes", () =>
      Effect.gen(function* () {
        const base = { HOME: "/users/me", F5_PROFILE_ISOLATED: "1" };
        for (const platform of ["darwin", "linux"] as const) {
          const work = yield* makeClaudeEnvironment({ homePath: "/homes/work" }, base, platform);
          const personal = yield* makeClaudeEnvironment(
            { homePath: "/homes/personal" },
            base,
            platform,
          );
          const unset = yield* makeClaudeEnvironment({ homePath: "" }, base, platform);
          const identities = new Set(
            [work, personal, unset].map((env) => claudeAccountUsageIdentity("claude", env)),
          );
          expect(identities.size).toBe(3);
          expect(claudeAccountUsageIdentity("claude", work)).toBe(
            claudeAccountUsageIdentity("claude", { ...work }),
          );
        }
      }),
    );
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
