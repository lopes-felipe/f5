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

it("keeps the offered streaming workload bounded under real client delta semantics", () => {
  const fixture = createBrowserFixture();
  const client = new Map<string, string>();
  let deltas = 0,
    replacements = 0;
  for (let frame = 0; frame < 200; frame++) {
    for (const event of fixture.nextEvents()) {
      const p = event.payload;
      const text = p.streaming ? (client.get(p.threadId) ?? "") + p.text : p.text;
      client.set(p.threadId, text);
      if (p.streaming) deltas++;
      else replacements++;
      expect(text.length).toBeLessThan(4000);
      expect(fixture.threads.find((t) => t.id === p.threadId)?.messages[1]?.text).toBe(text);
    }
  }
  expect(client.size).toBe(10);
  expect(deltas).toBe(1900);
  expect(replacements).toBe(100);
});
