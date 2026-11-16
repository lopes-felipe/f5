import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { expect, it } from "vitest";

import { ServerSecretStore } from "./auth/Services/ServerSecretStore.ts";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery.ts";
import { CheckpointStore } from "./checkpointing/Services/CheckpointStore.ts";
import { ServerConfig } from "./config.ts";
import { GitCore } from "./git/Services/GitCore.ts";
import { GitService } from "./git/Services/GitService.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { runProcess } from "./processRunner.ts";
import { makeServerGitLayers } from "./serverGitLayers.ts";

// Windows runs Git for Windows by its resolved path, so match the executable name.
const isGit = (command: string) => /^git(\.exe)?$/i.test(command.split(/[\\/]/).pop() ?? "");

it.each(["checkpoint query", "Git"])(
  "uses profile credentials in the runtime composition with %s built first",
  async (first) => {
    const credentialOutputs: string[] = [];
    const spawnerLayer = Layer.effect(
      ChildProcessSpawner.ChildProcessSpawner,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        return ChildProcessSpawner.make((command) => {
          if (
            command._tag === "StandardCommand" &&
            isGit(command.command) &&
            ["fetch", "ls-remote"].includes(command.args[0] ?? "")
          ) {
            // Replace only network I/O. Exercise the real profile environment and
            // credential helper with synthetic tokens, then return a successful process.
            return Effect.promise(() =>
              runProcess("git", ["credential", "fill"], {
                cwd: command.options.cwd,
                env: command.options.env ?? {},
                stdin: "protocol=https\nhost=github.com\n\n",
              }),
            ).pipe(
              Effect.tap((result) => Effect.sync(() => credentialOutputs.push(result.stdout))),
              Effect.flatMap(() =>
                spawner.spawn(ChildProcess.make("git", ["--version"], command.options)),
              ),
            );
          }
          return spawner.spawn(command);
        });
      }),
    ).pipe(Layer.provide(NodeServices.layer));
    const configLayer = Layer.effect(
      ServerConfig,
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        return { ...config, profile: { ...config.profile!, isDefault: false } };
      }),
    ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "f5-server-git-" })));
    const { gitLayer, checkpointDiffQueryLayer } = makeServerGitLayers();
    const consumers =
      first === "checkpoint query"
        ? Layer.mergeAll(checkpointDiffQueryLayer, gitLayer)
        : Layer.mergeAll(gitLayer, checkpointDiffQueryLayer);
    const layer = consumers.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(spawnerLayer),
      Layer.provideMerge(configLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const secrets = yield* ServerSecretStore;
        const checkpoints = yield* CheckpointStore;
        yield* CheckpointDiffQuery;
        const git = yield* GitService;
        const core = yield* GitCore;
        const cwd = config.stateDir;

        yield* fs.writeFileString(
          config.settingsPath!,
          JSON.stringify({ gitAuthorName: "Test", gitAuthorEmail: "test@example.com" }),
        );
        yield* core.initRepo({ cwd });
        yield* git.execute({
          operation: "test.commit",
          cwd,
          args: ["commit", "--allow-empty", "-m", "Fixture"],
        });
        const head = yield* git.execute({
          operation: "test.head",
          cwd,
          args: ["rev-parse", "HEAD"],
        });
        // The intercepted fetch leaves this fixture ref unchanged.
        yield* git.execute({
          operation: "test.remoteRef",
          cwd,
          args: ["update-ref", "refs/remotes/origin/main", head.stdout.trim()],
        });
        yield* git.execute({
          operation: "test.remote",
          cwd,
          args: ["remote", "add", "origin", "https://github.com/example/fixture.git"],
        });
        const fetch = () =>
          core.fetchRemoteBranchCommit({ cwd, branch: "main", allowMissingBranch: true });
        const disconnected = yield* Effect.result(fetch());
        expect(disconnected._tag).toBe("Failure");
        if (disconnected._tag === "Failure") {
          expect(disconnected.failure.detail).toContain("Connect github.com");
        }
        expect(credentialOutputs).toEqual([]);

        for (const token of ["initial-profile-token", "reconnected-profile-token"]) {
          yield* secrets.set("github-token-github.com", new TextEncoder().encode(token));
          expect(yield* checkpoints.isGitRepository(cwd)).toBe(true);
          const fetched = yield* fetch();
          expect(fetched?.commit).toBe(head.stdout.trim());
          const outputs = credentialOutputs.splice(0);
          expect(outputs).toHaveLength(2);
          for (const output of outputs) {
            expect(output).toContain(`password=${token}`);
          }
        }
      }).pipe(Effect.provide(layer)),
    );
  },
);
