import { PiSettings } from "@t3tools/contracts";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { fixture, run } from "../pi/PiMetadata.testkit.ts";
import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  piVersionSupportsF5,
} from "./PiProvider.ts";

it.each([
  ["0.80.3", false],
  ["0.80.4", false],
  ["0.80.5-rc.1", false],
  ["0.80.5", true],
  ["0.99.0", true],
  ["unknown", false],
] as const)("requires the published native history/settlement hooks: %s", (version, supported) =>
  expect(piVersionSupportsF5(version)).toBe(supported),
);
it("keeps Pi default and qualified custom models", () => {
  const snapshot = buildInitialPiProviderSnapshot(
    Schema.decodeUnknownSync(PiSettings)({ customModels: ["vendor/custom"] }),
  );
  expect(snapshot.models.map((model) => model.slug)).toEqual(["default", "vendor/custom"]);
});
it("does not spawn a process for disabled Pi instances", async () =>
  fixture(async (settings, environment, trace) => {
    const snapshot = await run(
      checkPiProviderStatus({ ...settings, enabled: false, customModels: [] }, environment),
    );
    expect(snapshot.status).toBe("disabled");
    await expect(trace()).rejects.toThrow();
  }));
it("reads versions and models without sending prompts or treating a model catalog as authentication proof", async () =>
  fixture(async (settings, environment, trace) => {
    const snapshot = await run(
      checkPiProviderStatus({ ...settings, enabled: true, customModels: [] }, environment),
    );
    expect(snapshot.status).toBe("ready");
    expect(snapshot.version).toBe("0.80.5");
    expect(snapshot.auth.status).toBe("unknown");
    expect(snapshot.models.map((model) => model.slug)).toEqual([
      "default",
      "one/shared",
      "two/shared",
    ]);
    const records = await trace();
    expect(records.some((record) => record.type === "prompt")).toBe(false);
    expect(
      records
        .filter((record) => record.type === "spawn")
        .every((record) => record.privateEnvironment === false),
    ).toBe(true);
  }));
it("rejects unsupported versions before RPC discovery", async () =>
  fixture(async (settings, environment, trace) => {
    const snapshot = await run(
      checkPiProviderStatus(
        { ...settings, enabled: true, customModels: [] },
        { ...environment, F5_PI_VERSION: "0.80.4" },
      ),
    );
    expect(snapshot.status).toBe("error");
    expect((await trace()).filter((record) => record.type === "spawn")).toHaveLength(1);
  }));
