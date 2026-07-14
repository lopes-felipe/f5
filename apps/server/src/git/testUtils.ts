import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Layer } from "effect";

import { GitService, type GitServiceShape } from "./Services/GitService.ts";

interface PushSpec {
  readonly source: string | null;
  readonly destination: string;
  readonly localBranch: string | null;
}

function resolveLocalRemotePath(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith("file://")) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return null;
    }
  }
  return isAbsolute(trimmed) ? trimmed : null;
}

function parsePushSpec(refspec: string, currentBranch: string): PushSpec | null {
  if (refspec === "HEAD") {
    return currentBranch.length > 0
      ? {
          source: "HEAD",
          destination: `refs/heads/${currentBranch}`,
          localBranch: currentBranch,
        }
      : null;
  }

  const separatorIndex = refspec.indexOf(":");
  if (separatorIndex >= 0) {
    const source = refspec.slice(0, separatorIndex) || null;
    const rawDestination = refspec.slice(separatorIndex + 1);
    if (rawDestination.length === 0) {
      return null;
    }
    return {
      source,
      destination: rawDestination.startsWith("refs/")
        ? rawDestination
        : `refs/heads/${rawDestination}`,
      localBranch: source === "HEAD" ? currentBranch || null : source,
    };
  }

  return {
    source: refspec,
    destination: `refs/heads/${refspec}`,
    localBranch: refspec,
  };
}

/**
 * Decorates the real Git service for integration tests that push to a local
 * repository. Local pushes are materialized with fetch/update-ref so they work
 * in restricted sandboxes. All other commands go directly to the real service,
 * avoiding the former shell -> Node wrapper -> Git process chain.
 */
export function makeLocalPushFriendlyGitService(base: GitServiceShape): GitServiceShape {
  const executeText = (
    input: Parameters<GitServiceShape["execute"]>[0],
    cwd: string,
    args: ReadonlyArray<string>,
  ) =>
    base
      .execute({
        ...input,
        cwd,
        args,
        allowNonZeroExit: false,
      })
      .pipe(Effect.map((result) => result.stdout.trim()));

  return {
    execute: (input) => {
      if (input.args[0] !== "push") {
        return base.execute(input);
      }

      return Effect.gen(function* () {
        const currentBranch = yield* executeText(input, input.cwd, ["branch", "--show-current"]);
        let setUpstream = false;
        let argumentIndex = 1;

        while (argumentIndex < input.args.length && input.args[argumentIndex]?.startsWith("-")) {
          const option = input.args[argumentIndex];
          if (option !== "-u" && option !== "--set-upstream") {
            return yield* base.execute(input);
          }
          setUpstream = true;
          argumentIndex += 1;
        }

        let remoteName = input.args[argumentIndex] ?? null;
        let refspecs = remoteName ? input.args.slice(argumentIndex + 1) : [];

        if (!remoteName) {
          const upstreamRef = yield* executeText(input, input.cwd, [
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
          ]);
          const separatorIndex = upstreamRef.indexOf("/");
          if (separatorIndex <= 0 || separatorIndex === upstreamRef.length - 1) {
            return yield* base.execute(input);
          }
          remoteName = upstreamRef.slice(0, separatorIndex);
          refspecs = [`HEAD:${upstreamRef.slice(separatorIndex + 1)}`];
        }

        const remoteUrl = yield* executeText(input, input.cwd, ["remote", "get-url", remoteName]);
        const remotePath = resolveLocalRemotePath(remoteUrl);
        if (!remotePath) {
          return yield* base.execute(input);
        }

        const specs = (refspecs.length > 0 ? refspecs : ["HEAD"])
          .map((refspec) => parsePushSpec(refspec, currentBranch))
          .filter((spec): spec is PushSpec => spec !== null);
        if (specs.length === 0) {
          return yield* base.execute(input);
        }

        for (const spec of specs) {
          if (spec.source === null) {
            yield* executeText(input, remotePath, ["update-ref", "-d", spec.destination]);
            if (spec.destination.startsWith("refs/heads/")) {
              const remoteBranch = spec.destination.slice("refs/heads/".length);
              yield* executeText(input, input.cwd, [
                "update-ref",
                "-d",
                `refs/remotes/${remoteName}/${remoteBranch}`,
              ]);
            }
            continue;
          }

          const sourceSha = yield* executeText(input, input.cwd, ["rev-parse", spec.source]);
          yield* executeText(input, remotePath, [
            "fetch",
            input.cwd,
            `${sourceSha}:${spec.destination}`,
          ]);

          if (!spec.destination.startsWith("refs/heads/")) {
            continue;
          }
          const remoteBranch = spec.destination.slice("refs/heads/".length);
          yield* executeText(input, input.cwd, [
            "update-ref",
            `refs/remotes/${remoteName}/${remoteBranch}`,
            sourceSha,
          ]);
          if (setUpstream && spec.localBranch) {
            yield* executeText(input, input.cwd, [
              "branch",
              "--set-upstream-to",
              `${remoteName}/${remoteBranch}`,
              spec.localBranch,
            ]);
          }
        }

        return { code: 0, stdout: "", stderr: "" };
      });
    },
  };
}

export function makeLocalPushFriendlyGitServiceLayer<R, E>(
  baseLayer: Layer.Layer<GitService, E, R>,
): Layer.Layer<GitService, E, R> {
  return Layer.effect(
    GitService,
    Effect.service(GitService).pipe(Effect.map(makeLocalPushFriendlyGitService)),
  ).pipe(Layer.provide(baseLayer));
}
