export interface DesktopBackendEnvOptions {
  readonly backendPort: number;
  readonly stateDir: string;
  readonly authToken: string;
}

export function buildDesktopBackendEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: DesktopBackendEnvOptions,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    T3CODE_MODE: "desktop",
    T3CODE_NO_BROWSER: "1",
    T3CODE_PORT: String(options.backendPort),
    T3CODE_STATE_DIR: options.stateDir,
    T3CODE_AUTH_TOKEN: options.authToken,
    ...(baseEnv.T3CODE_OBSERVABILITY_ENABLED !== undefined
      ? {
          T3CODE_OBSERVABILITY_ENABLED: baseEnv.T3CODE_OBSERVABILITY_ENABLED,
        }
      : {}),
  };
}
