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

it("answers background clone polling without adding fixture work", () => {
  expect(createBrowserFixture().rpc({ _tag: "projects.cloneList" })).toEqual([]);
});

it("answers project settings polling without silently skipping a renderer query", () => {
  const fixture = createBrowserFixture();
  expect(
    fixture.rpc({ _tag: "server.getProjectSettings", projectId: "perf-project" }),
  ).toMatchObject({ settings: { defaultThreadEnvMode: "local" }, overrides: {} });
  expect([...fixture.unknownMethods]).toEqual([]);
});

it("answers worktree setup subscriptions without adding setup work", () => {
  const fixture = createBrowserFixture();
  expect(fixture.rpc({ _tag: "worktreeSetup.subscribe", threadId: "perf-small" })).toBeNull();
  expect([...fixture.unknownMethods]).toEqual([]);
});

it("answers rewind draft reads without adding draft work", () => {
  const fixture = createBrowserFixture();
  expect(fixture.rpc({ _tag: "orchestration.getRewindDrafts", threadId: "perf-small" })).toEqual({
    threadId: "perf-small",
    drafts: [],
  });

  expect([...fixture.unknownMethods]).toEqual([]);
});
