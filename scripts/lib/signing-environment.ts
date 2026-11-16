/** Dependency installers and application compilation never receive signing credentials. */
export function withoutSigningCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !/^(CSC_|APPLE_|AZURE_)/i.test(key)),
  );
}
