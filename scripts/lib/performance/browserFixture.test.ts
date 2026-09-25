import { expect, it } from "vitest";
import { createBrowserFixture } from "./browserFixture";

it("uses the tested build's protocol without changing the benchmark workload", () => {
  const current = createBrowserFixture(42);
  const legacy = createBrowserFixture();
  expect(current.welcome.bootstrap.protocolVersion).toBe(42);
  expect(legacy.welcome.bootstrap.protocolVersion).toBe(1);
  expect(current.threads.map(({ id, messages }) => [id, messages.length])).toEqual(
    legacy.threads.map(({ id, messages }) => [id, messages.length]),
  );
});
