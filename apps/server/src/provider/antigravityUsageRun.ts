import { acquireAccountAdmission } from "../profiles/ProviderAccountGuard.ts";
import { AccountUsageReadError } from "../usage/accountUsageErrors.ts";
import {
  runAntigravityUsageCommand,
  type AntigravityUsageRun,
} from "../usage/antigravityCliUsage.ts";
import { antigravityEnvironment, prepareAntigravityProfile } from "./acp/AntigravityAcpSupport.ts";
import {
  antigravityAccountKey,
  antigravityReadiness,
  isAntigravityAuthCurrent,
  readAntigravityAuthState,
  type AntigravityAuthConfig,
} from "./antigravityAuthSupport.ts";

/** Seams for tests; production uses the real guard, auth state, installation and process. */
export interface AntigravityUsageRunDependencies {
  readonly acquireAdmission: typeof acquireAccountAdmission;
  readonly isAuthCurrent: typeof isAntigravityAuthCurrent;
  readonly readiness: typeof antigravityReadiness;
  readonly revision: (profileDirectory: string) => Promise<number>;
  readonly accountKey: typeof antigravityAccountKey;
  readonly prepare: typeof prepareAntigravityProfile;
  readonly runCommand: typeof runAntigravityUsageCommand;
}

const defaults: AntigravityUsageRunDependencies = {
  acquireAdmission: acquireAccountAdmission,
  isAuthCurrent: isAntigravityAuthCurrent,
  readiness: antigravityReadiness,
  revision: (profileDirectory) =>
    readAntigravityAuthState(profileDirectory).then((state) => state.revision),
  accountKey: antigravityAccountKey,
  prepare: prepareAntigravityProfile,
  runCommand: runAntigravityUsageCommand,
};

/**
 * How one Antigravity instance runs `/usage`. Account admission is held from before the sign-in
 * checks until the CLI exits, as for a session launch: Connect, Disconnect and provider updates
 * wait for the run (at most 30 seconds) instead of changing the sign-in files it is using. The
 * executable is resolved once, so the version that is gated is the binary that runs.
 */
export function makeAntigravityUsageRun(input: {
  readonly stateDir: string;
  readonly instanceId: string;
  readonly profileDirectory: string;
  readonly auth: AntigravityAuthConfig;
  readonly keyUnavailable: boolean;
  /** The instance's process environment (`buildAccountExecutionEnvironment`). */
  readonly environment: NodeJS.ProcessEnv;
  readonly dependencies?: Partial<AntigravityUsageRunDependencies>;
}): AntigravityUsageRun {
  const deps = { ...defaults, ...input.dependencies };
  const { stateDir, instanceId, profileDirectory, auth } = input;
  return async (signal, body) => {
    let release: () => void;
    try {
      release = deps.acquireAdmission(stateDir, instanceId);
    } catch {
      throw new AccountUsageReadError("temporary-failure");
    }
    try {
      if (!deps.isAuthCurrent(stateDir, instanceId, auth))
        throw new AccountUsageReadError("temporary-failure");
      const readiness = await deps.readiness({
        profileDirectory,
        auth,
        keyUnavailable: input.keyUnavailable,
      });
      if (!readiness.ready) throw new AccountUsageReadError("authentication-required");
      const before = await deps.revision(profileDirectory);
      const account = await deps.accountKey(profileDirectory);
      let prepared: Awaited<ReturnType<typeof prepareAntigravityProfile>>;
      try {
        prepared = await deps.prepare({
          stateDir,
          instanceId,
          environment: input.environment,
          auth,
        });
      } catch {
        throw new AccountUsageReadError("process-unavailable");
      }
      const environment = antigravityEnvironment(
        input.environment,
        prepared.home,
        prepared.executable.harnessPath,
        prepared.browser,
        auth,
      );
      const value = await body({
        version: prepared.executable.version ?? null,
        account,
        spawn: () =>
          deps
            .runCommand({
              executablePath: prepared.executable.executablePath,
              profileDirectory: prepared.home,
              environment,
              signal,
            })
            .catch(() => {
              throw new AccountUsageReadError("process-unavailable");
            }),
      });
      // Admission keeps account jobs out; a revision change here means the state moved anyway.
      if ((await deps.revision(profileDirectory)) !== before)
        throw new AccountUsageReadError("temporary-failure");
      return value;
    } finally {
      release();
    }
  };
}
