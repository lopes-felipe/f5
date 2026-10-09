import { afterEach, describe, expect, it, vi } from "vitest";

// SERVER_BOOTSTRAP reads the environment at import time.
async function loadCapabilities(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) vi.stubEnv("F5_COMPOSER_REDESIGN", undefined as unknown as string);
  else vi.stubEnv("F5_COMPOSER_REDESIGN", value);
  const { SERVER_BOOTSTRAP } = await import("./protocol.ts");
  return SERVER_BOOTSTRAP.capabilities;
}

describe("SERVER_BOOTSTRAP composer redesign capability", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, "", "1", "true"])("is advertised when the flag is %j", async (value) => {
    expect(await loadCapabilities(value)).toContain("composer-redesign");
  });

  it("is omitted when the flag is 0", async () => {
    expect(await loadCapabilities("0")).not.toContain("composer-redesign");
  });
});
