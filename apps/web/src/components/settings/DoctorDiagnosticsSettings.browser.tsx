import "../../index.css";
import type { ServerDoctorReport } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { DoctorDiagnosticsSettings } from "./DoctorDiagnosticsSettings";

const state = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../lib/serverReactQuery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/serverReactQuery")>();
  return {
    ...actual,
    serverDoctorReportQueryOptions: () => ({
      queryKey: ["server-doctor-fixture"],
      queryFn: state.read,
      enabled: false,
    }),
  };
});

afterEach(() => state.read.mockReset());

const healthyReport: ServerDoctorReport = {
  generatedAt: "2026-11-24T22:00:00.000Z",
  overallStatus: "ok",
  runtime: {
    appVersion: "0.1.11",
    platform: "darwin",
    arch: "arm64",
    runtimeKind: "node",
    runtimeVersion: "v22.16.0",
    profileSlug: "default",
    profileName: "Default",
    isDefaultProfile: true,
    mode: "desktop",
  },
  counts: { ok: 2, warn: 0, error: 0 },
  providers: [
    {
      id: "codex-default",
      label: "Codex",
      status: "ready",
      version: "0.170.0",
      summary: "Ready · authenticated",
    },
  ],
  checks: [
    {
      id: "db.integrity",
      category: "database",
      title: "SQLite integrity & schema",
      status: "ok",
      summary: "quick_check OK · 4 MB (3.8 MB live, 200 KB free) · 178 migrations applied.",
    },
    {
      id: "env.git",
      category: "environment",
      title: "Git CLI",
      status: "ok",
      summary: "Found at /usr/bin/git.",
    },
  ],
};

const mount = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DoctorDiagnosticsSettings />
    </QueryClientProvider>,
  );

it("does not run diagnostics on mount and renders checks only after clicking Run check", async () => {
  state.read.mockResolvedValue(healthyReport);
  await mount();

  // Mounting the card must never trigger an automatic server health scan.
  expect(state.read).not.toHaveBeenCalled();
  await expect.element(page.getByRole("button", { name: "Export support bundle" })).toBeDisabled();

  await page.getByRole("button", { name: "Run check" }).click();

  await expect.element(page.getByText("Healthy")).toBeInTheDocument();
  await expect.element(page.getByText("SQLite integrity & schema")).toBeInTheDocument();
  await expect.element(page.getByText("Codex")).toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Export support bundle" })).toBeEnabled();

  state.read.mockResolvedValue({
    ...healthyReport,
    overallStatus: "warn",
    counts: { ok: 1, warn: 1, error: 0 },
    checks: [
      ...healthyReport.checks,
      {
        id: "env.legacy-vars",
        category: "environment",
        title: "Legacy T3CODE_* environment variables",
        status: "warn",
        summary: "1 legacy variable set: T3CODE_PORT.",
        hint: "Rename them to their F5_* equivalents.",
      },
    ],
  });
  await page.getByRole("button", { name: "Run check" }).click();
  await expect.element(page.getByText("Warnings")).toBeInTheDocument();
  await expect.element(page.getByText("Legacy T3CODE_* environment variables")).toBeInTheDocument();
});

it("shows an error state when clicking Run check fails", async () => {
  state.read.mockRejectedValue(new Error("offline"));
  await mount();
  expect(state.read).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Run check" }).click();
  await expect
    .element(page.getByText("System health check could not be loaded."))
    .toBeInTheDocument();
});
