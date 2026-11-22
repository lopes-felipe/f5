// Entry for the Linux VM supervisor process main spawns (see vmBackendLauncher.ts). It must
// never touch process.stdin or process.stdout: they are main's channel to the guest backend.
// Its one frame to main (forward ready) goes straight to fd 1, which stays a blocking pipe
// only while process.stdout is never opened.
import {
  defaultVmSupervisorDeps,
  parseVmSupervisorConfig,
  runVmSupervisor,
  VM_REFUSED_EXIT_CODE,
  type VmSupervisorConfig,
} from "./vmSupervisor";

let config: VmSupervisorConfig;
try {
  config = parseVmSupervisorConfig(process.env.F5_VM_SUPERVISOR_CONFIG);
} catch (error) {
  console.error(`[vm] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(VM_REFUSED_EXIT_CODE);
}
delete process.env.F5_VM_SUPERVISOR_CONFIG;

const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());

runVmSupervisor(config, defaultVmSupervisorDeps(config), stop.signal).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(
      `[vm] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exit(1);
  },
);
