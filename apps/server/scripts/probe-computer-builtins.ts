import { userInfo } from "node:os";
import { inspectCodexChrome } from "../src/computer/codexNativeIntegrations";
import { probeComputerBuiltin } from "../src/computer/computerBuiltinAvailability";

// Read-only identity only; this command never enables plugins or starts a provider session.
const [claudeComputer, codexComputer, codexChrome] = await Promise.all([
  probeComputerBuiltin({ provider: "claude", platform: process.platform }),
  probeComputerBuiltin({ provider: "codex", platform: process.platform }),
  inspectCodexChrome({ userHome: userInfo().homedir }).then((result) =>
    result.available
      ? {
          available: true,
          recordId: result.record.id,
          appVersion: result.appVersion,
          pluginVersion: result.pluginVersion,
          registrations: result.registrations.filter((entry) => entry.state === "ok").length,
        }
      : result,
  ),
]);
process.stdout.write(JSON.stringify({ claudeComputer, codexComputer, codexChrome }) + "\n");
