import * as Path from "node:path";

/** GitHub identity is profile-owned, including in Default. Apply after user overrides. */
export function profileGithubEnvironment(
  base: NodeJS.ProcessEnv,
  stateDir: string,
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(base).filter(
      ([key]) =>
        !/^(?:(?:GH|GITHUB)_.*TOKEN|GH_CONFIG_DIR|GH_HOST|GH_REPO|GH_DEBUG)$/.test(
          key.toUpperCase(),
        ),
    ),
  );
  environment.GH_CONFIG_DIR = Path.join(stateDir, "github");
  return environment;
}
