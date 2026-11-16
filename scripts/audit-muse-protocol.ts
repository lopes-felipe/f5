/**
 * `bun run protocol:audit:muse` — verifies the installed `@muse-code/sdk`
 * matches F5's pinned Muse Session Protocol manifest and recorded fixture.
 *
 * `MUSE_LIVE=1` additionally runs the permission conformance checks against
 * the real `muse` binary (needs a signed-in CLI or META_API_KEY), separately
 * for file edits and commands, in both runtime modes F5 offers.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { EXPECTED_SCHEMA_FINGERPRINT, MuseClient, type Session } from "@muse-code/sdk";
import {
  MUSE_APPROVAL_MODE_BY_RUNTIME_MODE,
  MUSE_CLI_BASELINE_VERSION,
  MUSE_EXPECTED_SCHEMA_FINGERPRINT,
  MUSE_FORBIDDEN_ARGS,
  MUSE_SDK_VERSION,
  MUSE_SERVE_ARGS,
  MUSE_WIRE_DECLARATIONS_SHA256,
} from "@t3tools/shared/museProtocolManifest";

import {
  diffMuseProtocolSurface,
  extractMuseProtocolSurface,
  hasMuseProtocolDrift,
  type MuseProtocolSurface,
} from "./museProtocolAudit.ts";

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "fixtures/muse-protocol",
  MUSE_SDK_VERSION,
  "surface.json",
);

interface MuseProtocolFixture extends MuseProtocolSurface {
  readonly sdkVersion: string;
  readonly cliVersion: string;
  readonly schemaFingerprint: string;
  readonly wireDeclarationsSha256: string;
}

const require = createRequire(import.meta.url);

async function auditPin(): Promise<boolean> {
  const sdkEntry = require.resolve("@muse-code/sdk");
  const sdkRoot = path.resolve(path.dirname(sdkEntry), "../..");
  const packageJson = JSON.parse(await readFile(path.join(sdkRoot, "package.json"), "utf8")) as {
    version: string;
  };
  const declarations = await readFile(path.join(sdkRoot, "dist/src/msp.d.ts"), "utf8");
  const declarationsSha = createHash("sha256").update(declarations).digest("hex");
  const surface = extractMuseProtocolSurface(declarations);
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as MuseProtocolFixture;
  const drift = diffMuseProtocolSurface(surface);

  const checks: Array<[string, boolean]> = [
    [
      `SDK version ${packageJson.version} = ${MUSE_SDK_VERSION}`,
      packageJson.version === MUSE_SDK_VERSION,
    ],
    [
      `SDK fingerprint pin = manifest`,
      EXPECTED_SCHEMA_FINGERPRINT === MUSE_EXPECTED_SCHEMA_FINGERPRINT &&
        fixture.schemaFingerprint === MUSE_EXPECTED_SCHEMA_FINGERPRINT,
    ],
    [
      `wire declarations sha256 = manifest`,
      declarationsSha === MUSE_WIRE_DECLARATIONS_SHA256 &&
        fixture.wireDeclarationsSha256 === MUSE_WIRE_DECLARATIONS_SHA256,
    ],
    [
      `fixture surface matches installed SDK`,
      JSON.stringify([fixture.methods, fixture.notifications, fixture.serverRequests]) ===
        JSON.stringify([surface.methods, surface.notifications, surface.serverRequests]),
    ],
    [`every notification has a disposition`, !hasMuseProtocolDrift(drift)],
    [
      `serve args avoid ${MUSE_FORBIDDEN_ARGS.join(", ")}`,
      !MUSE_SERVE_ARGS.some((arg) => (MUSE_FORBIDDEN_ARGS as readonly string[]).includes(arg)),
    ],
  ];
  console.log(
    `Muse protocol audit: SDK ${packageJson.version}, CLI baseline ${MUSE_CLI_BASELINE_VERSION}`,
  );
  for (const [label, ok] of checks) console.log(`  ${ok ? "ok" : "FAIL"}  ${label}`);
  for (const [label, entries] of Object.entries(drift)) {
    for (const entry of entries) console.log(`  ! ${label}: ${entry}`);
  }
  return checks.every(([, ok]) => ok);
}

type Probe = "edit-in-workspace" | "unlisted-command" | "write-outside-workspace";

const PROBE_PROMPTS: Record<Probe, string> = {
  "edit-in-workspace":
    "Create a file named f5-audit.txt in the current workspace containing the word ok. Do nothing else.",
  "unlisted-command": "Run the shell command `uname -a` and report its output. Do nothing else.",
  "write-outside-workspace":
    "Write the word ok to the file /tmp/f5-muse-audit-outside.txt. Do nothing else.",
};

/** Whether the probe asked for approval; approvals are always denied. */
async function runProbe(session: Session, probe: Probe): Promise<"asked" | "silent"> {
  let asked = false;
  session.onApproval((request) => {
    asked = true;
    const deny = request.availableChoices.find((choice) => choice.decision === "denied");
    return { choiceId: (deny ?? request.availableChoices[0]!).choiceId };
  });
  const turn = await session.sendUserTurn({
    input: [{ type: "text", text: PROBE_PROMPTS[probe] }],
  });
  await turn.completed;
  return asked ? "asked" : "silent";
}

async function auditLive(): Promise<boolean> {
  const binary = process.env.MUSE_BINARY_PATH?.trim() || "muse";
  const expectations: Record<
    keyof typeof MUSE_APPROVAL_MODE_BY_RUNTIME_MODE,
    Record<Probe, ReadonlyArray<"asked" | "silent">>
  > = {
    // Muse auto-approves in-workspace edits in every mode.
    "auto-accept-edits": {
      "edit-in-workspace": ["silent"],
      "unlisted-command": ["asked"],
      "write-outside-workspace": ["asked", "silent"], // silent only if the sandbox denied it
    },
    "full-access": {
      "edit-in-workspace": ["silent"],
      "unlisted-command": ["silent"],
      "write-outside-workspace": ["silent"],
    },
  };
  let ok = true;
  for (const [runtimeMode, probes] of Object.entries(expectations)) {
    for (const [probe, allowed] of Object.entries(probes) as Array<
      [Probe, ReadonlyArray<string>]
    >) {
      const workspace = await mkdtemp(path.join(tmpdir(), "f5-muse-live-"));
      const client = await MuseClient.spawn({
        museBin: binary,
        args: [...MUSE_SERVE_ARGS],
        cwd: workspace,
        clientInfo: { name: "F5 protocol audit", version: MUSE_SDK_VERSION },
      });
      try {
        if (client.initializeResult.sandboxAvailability !== "available") {
          console.log(`  FAIL  sandbox unavailable on this host`);
          return false;
        }
        const session = await client.startSession({
          workspaceRoot: workspace,
          approvalMode:
            MUSE_APPROVAL_MODE_BY_RUNTIME_MODE[
              runtimeMode as keyof typeof MUSE_APPROVAL_MODE_BY_RUNTIME_MODE
            ],
        });
        const outcome = await runProbe(session, probe);
        const passed = allowed.includes(outcome);
        ok &&= passed;
        console.log(`  ${passed ? "ok" : "FAIL"}  ${runtimeMode} ${probe}: ${outcome}`);
      } finally {
        await client.close().catch(() => undefined);
        await rm(workspace, { recursive: true, force: true });
      }
    }
  }
  return ok;
}

async function main(): Promise<void> {
  let ok = await auditPin();
  if (process.env.MUSE_LIVE === "1") {
    console.log("Live permission conformance:");
    ok = (await auditLive()) && ok;
  }
  if (!ok) process.exitCode = 1;
}

await main();
