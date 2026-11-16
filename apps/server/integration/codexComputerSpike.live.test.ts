import { readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_REQUIRED_ASSERTIONS,
  type CodexComputerRecord,
  type IntegrationEvidenceReport,
} from "@t3tools/shared/providerIntegrationCertification";

import { inspectCodexComputer } from "../src/computer/codexNativeIntegrations";
import { IntegrationProxySession, type IntegrationTool } from "../src/mcp/IntegrationProxyCatalog";
import { evidenceSource } from "./fixtures/evidenceSource";

/**
 * Sky (Codex Computer Use) spike through F5's integration proxy, outside F5. The gate
 * stays closed: the candidate record comes from a dev-only spike file, never from the
 * bundled certification records, and the run only writes a report.
 *
 * F5_CODEX_NATIVE_LIVE=computer opts in. F5_CODEX_COMPUTER_SPIKE=<file> holds
 * `{ record, cases }`: the candidate record (paths, versions, identity) and, per targeting
 * assertion, the call to make once the inventory is known. F5_CODEX_COMPUTER_REPORT=<file>
 * receives the report, including every tool's schema.
 */
interface SpikeCase {
  readonly tool: string;
  readonly arguments: unknown;
  /** Sky must refuse this call (ambiguous or F5 targets) or must perform it. */
  readonly expectRefusal: boolean;
  /** Text that must not appear in the observation, such as an F5 window title. */
  readonly mustNotContain?: string;
  /**
   * Positive control: text the observation must contain (the target window's marker), so
   * an empty or failed observation cannot pass a performed case.
   */
  readonly mustContain?: string;
}
interface SpikeFile {
  readonly record: CodexComputerRecord;
  readonly cases?: Partial<Record<string, SpikeCase>>;
}

const optedIn = process.env.F5_CODEX_NATIVE_LIVE === "computer";
const text = (result: { content: ReadonlyArray<{ type: string; text?: string }> }) =>
  result.content.map((block) => block.text ?? "").join("");

describe.skipIf(!optedIn)("Codex Computer Use spike", () => {
  it("launches Sky through the proxy and records targeting, exclusion and cancellation", async () => {
    if (process.env.F5_AGENT_PROCESS === "1")
      throw new Error("Run the Computer Use spike outside F5, not from an F5 agent.");
    if (process.platform !== "darwin") throw new Error("The Computer Use spike is macOS only.");
    const spikePath = process.env.F5_CODEX_COMPUTER_SPIKE;
    if (!spikePath) throw new Error("Set F5_CODEX_COMPUTER_SPIKE to the spike file.");
    const spike = JSON.parse(await readFile(spikePath, "utf8")) as SpikeFile;
    // Taken before anything runs; keep the spike file outside the checkout.
    const source = evidenceSource();
    const installation = await inspectCodexComputer({
      userHome: userInfo().homedir,
      record: spike.record,
    });
    if (!installation.available) throw new Error(installation.reason);
    const assertions: Record<string, boolean> = Object.fromEntries(
      INTEGRATION_REQUIRED_ASSERTIONS["codex-computer"].map((name) => [name, false]),
    );
    const timings: Record<string, number> = {};
    let observed: { sha256: string; tools: ReadonlyArray<IntegrationTool> } | undefined;
    const open = (inventory: string | undefined, allowedTools: ReadonlyArray<string>) =>
      new IntegrationProxySession({
        integration: "codex-computer",
        threadId: "spike",
        generation: "spike",
        command: installation.clientPath,
        args: ["mcp"],
        env: { PATH: process.env.PATH ?? "", HOME: userInfo().homedir, USER: userInfo().username },
        allowedTools,
        toolInventorySha256: inventory,
        identity: {
          profileId: "spike",
          backendIncarnation: "spike",
          threadId: "spike",
          sessionGeneration: "spike",
          integration: "codex-computer",
        },
        register: async () => {},
        inventoryObserved: (sha256, tools) => {
          observed = { sha256, tools };
        },
        policyEnabled: async () => true,
        currentGeneration: () => "spike",
        paused: () => false,
        consent: async () => true,
        acquireLease: async () => {},
        releaseLease: () => {},
      });

    // Launch and inventory: the record has none until this run records it.
    const probe = open(undefined, []);
    // Without a recorded digest verification fails after reporting what was listed.
    await probe.verifyInventory().catch(() => undefined);
    await probe.dispose();
    // `launch` and `f5-windows-excluded` stay false: this harness spawns the client itself
    // rather than from F5's sandboxed backend, and runs without F5's content protection,
    // so it cannot observe either. They need the packaged-app run.
    const observations: Record<string, unknown> = {
      launchedOutsideBackend: observed !== undefined,
    };
    if (!observed) throw new Error("SkyComputerUseClient listed no tools.");
    const names = observed.tools.map((tool) => tool.name);
    assertions["tool-inventory"] = names.length > 0 && /^[a-f0-9]{64}$/.test(observed.sha256);
    const session = open(observed.sha256, names);
    try {
      for (const name of ["target-enforced", "ambiguous-target-refused", "f5-target-refused"]) {
        const spec = spike.cases?.[name];
        if (!spec) continue;
        const result = await session.callTool(spec.tool, spec.arguments);
        const output = text(result);
        const refused = result.isError === true;
        // A refusal must be a refusal; a performed call must show its positive control.
        assertions[name] =
          refused === spec.expectRefusal &&
          (spec.expectRefusal ||
            (spec.mustContain !== undefined && output.includes(spec.mustContain))) &&
          (spec.mustNotContain === undefined || !output.includes(spec.mustNotContain));
        observations[name] = { refused, outputBytes: output.length };
      }
      const cancel = spike.cases?.["cancel-stops"];
      if (cancel) {
        const pending = session.callTool(cancel.tool, cancel.arguments);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const started = Date.now();
        session.cancel();
        const result = await pending;
        timings.cancelToSettledMs = Date.now() - started;
        assertions["cancel-stops"] = result.isError === true && session.inFlight.length === 0;
      }
    } finally {
      await session.dispose();
    }

    const record = spike.record;
    const report: IntegrationEvidenceReport & {
      readonly timings: Record<string, number>;
      readonly observations: Record<string, unknown>;
    } = {
      integration: "codex-computer",
      evidenceId: process.env.F5_CODEX_COMPUTER_EVIDENCE_ID ?? "uncommitted",
      platform: process.platform,
      arch: process.arch,
      // The record's paths, and the exercised versions stamped as its floors.
      versions: {
        ...Object.fromEntries(
          Object.entries(record.versions).filter(
            ([key]) => !key.endsWith("Min") && !key.endsWith("Max"),
          ),
        ),
        appMin: installation.appVersion,
        serviceMin: installation.version,
      },
      assertions,
      toolNames: names,
      toolInventorySha256: observed.sha256,
      toolSchemas: observed.tools.map(({ name, description, inputSchema }) => ({
        name,
        ...(description !== undefined ? { description } : {}),
        inputSchema,
      })),
      ...source,
      timings,
      observations,
    };
    if (process.env.F5_CODEX_COMPUTER_REPORT)
      await writeFile(process.env.F5_CODEX_COMPUTER_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    // Any failure keeps codex-computer uncertified; the report names which one.
    expect(Object.entries(assertions).filter(([, passed]) => !passed)).toEqual([]);
  }, 300_000);
});
