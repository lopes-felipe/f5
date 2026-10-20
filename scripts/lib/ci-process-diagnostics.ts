import { createRequire } from "node:module";
import { homedir } from "node:os";

const { writeDiagnostics } = createRequire(import.meta.url)("./ci-diagnostics.cjs") as {
  writeDiagnostics: (
    directory: string | undefined,
    name: string,
    details: { logs: string; failure: string; paths: string[] },
  ) => void;
};

/** Explicit process text only. Temporary profiles and state files never leave the harness. */
export function writeCiProcessDiagnostics(
  name: string,
  logs: string,
  failure: unknown,
  paths: string[] = [],
): void {
  writeDiagnostics(process.env.F5_CI_ARTIFACT_DIR, name, {
    logs,
    failure: failure ? String(failure instanceof Error ? failure.stack : failure) : "",
    paths: [...paths, homedir(), process.cwd()],
  });
}
