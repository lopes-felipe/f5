import { probeCodexBundledRuntime } from "../src/computer/codexBundledRuntime";
import { probeComputerBuiltin } from "../src/computer/computerBuiltinAvailability";

// Metadata only; this command never enables plugins or starts a provider session.
const [claudeComputer, codexComputer, codexChrome] = await Promise.all([
  probeComputerBuiltin({ provider: "claude", platform: process.platform }),
  probeCodexBundledRuntime({ capability: "computer", platform: process.platform }),
  probeCodexBundledRuntime({ capability: "chrome", platform: process.platform }),
]);
process.stdout.write(JSON.stringify({ claudeComputer, codexComputer, codexChrome }) + "\n");
