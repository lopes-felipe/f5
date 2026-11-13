import "../../index.css";
import type { ServerHealth } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ServerHealthSettings } from "./ServerHealthSettings";

const state = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../lib/serverReactQuery", () => ({
  serverHealthQueryOptions: () => ({ queryKey: ["server-health-fixture"], queryFn: state.read }),
}));
afterEach(() => state.read.mockReset());

const health: ServerHealth = {
  startedAt: "2026-01-01T00:00:00.000Z",
  uptimeMs: 3 * 3_600_000,
  rssBytes: 900 * 1024 * 1024,
  heapUsedBytes: 400 * 1024 * 1024,
  eventLoopDelay: { p50Ms: 0, p99Ms: 240, maxMs: 7_300 },
  slowRouteThresholdMs: 1_000,
  slowStatementThresholdMs: 100,
  slowRoutes: [
    {
      name: "git.status",
      count: 12,
      totalMs: 21_000,
      maxMs: 5_900,
      lastAt: new Date().toISOString(),
    },
  ],
  slowStatements: [],
};

const mount = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ServerHealthSettings />
    </QueryClientProvider>,
  );

it("shows the totals for slow requests and says when nothing was slow", async () => {
  state.read.mockResolvedValue(health);
  await mount();

  await expect.element(page.getByText("900 MB (heap 400 MB)")).toBeInTheDocument();
  await expect
    .element(page.getByText("typical 0ms, 99th percentile 240ms, worst 7.3s"))
    .toBeInTheDocument();
  const row = page.getByRole("row", { name: /git\.status/ });
  await expect.element(row).toHaveTextContent("12");
  await expect.element(row).toHaveTextContent("21s");
  await expect.element(row).toHaveTextContent("5.9s");
  await expect
    .element(page.getByRole("heading", { name: "Requests that took 1s or longer" }))
    .toBeInTheDocument();
  await expect
    .element(page.getByRole("heading", { name: "Database statements slower than 100ms" }))
    .toBeInTheDocument();
  await expect.element(page.getByText("None since the server started.")).toBeInTheDocument();
});

it("reads again on Refresh", async () => {
  state.read.mockResolvedValue(health);
  await mount();
  await expect.element(page.getByRole("row", { name: /git\.status/ })).toBeInTheDocument();

  state.read.mockResolvedValue({
    ...health,
    slowStatements: [
      {
        name: "SELECT * FROM projection_threads",
        count: 2,
        totalMs: 900,
        maxMs: 700,
        lastAt: new Date().toISOString(),
      },
    ],
  });
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect
    .element(page.getByRole("row", { name: /SELECT \* FROM projection_threads/ }))
    .toHaveTextContent("900ms");
});

it("says so when the server cannot be read", async () => {
  state.read.mockRejectedValue(new Error("offline"));
  await mount();
  await expect.element(page.getByText("Server health could not be loaded.")).toBeInTheDocument();
});
