import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { DiagnosticsSettings } from "./DiagnosticsSettings";

const state = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("./SettingsRouteContext", () => ({
  useSettingsRouteContext: () => ({
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      observability: {
        otlpTracesUrl: "",
        otlpMetricsUrl: "",
        otlpHeaders: [{ name: "existing", value: "", valueRedacted: true }],
      },
    },
    updateSettings: state.update,
  }),
}));
vi.mock("../../lib/serverReactQuery", () => ({
  serverConfigQueryOptions: () => ({
    queryKey: ["diagnostics-fixture"],
    queryFn: async () => ({
      diagnostics: {
        traces: { endpoint: "https://collector.test/v1/traces", source: "environment" },
        metrics: { endpoint: null, source: "unset" },
      },
    }),
  }),
}));
afterEach(() => state.update.mockClear());
it("shows the effective source and saves credentials through settings without revealing stored values", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={client}>
      <DiagnosticsSettings />
    </QueryClientProvider>,
  );
  await expect
    .element(page.getByText("Source: environment · https://collector.test/v1/traces"))
    .toBeInTheDocument();
  await page.getByLabelText("Collector header name").fill("Authorization");
  await page.getByLabelText("Collector header value").fill("Bearer new-private-value");
  expect(page.getByLabelText("Collector header value").element().getAttribute("type")).toBe(
    "password",
  );
  await page.getByRole("button", { name: "Save header" }).click();
  expect(state.update).toHaveBeenLastCalledWith({
    observability: {
      otlpTracesUrl: "",
      otlpMetricsUrl: "",
      otlpHeaders: [
        { name: "existing", value: "", valueRedacted: true },
        { name: "Authorization", value: "Bearer new-private-value" },
      ],
    },
  });
  expect(document.body.textContent).not.toContain("new-private-value");
  await page.getByLabelText("Remove existing header").click();
  expect(state.update).toHaveBeenLastCalledWith({
    observability: { otlpTracesUrl: "", otlpMetricsUrl: "", otlpHeaders: [] },
  });
  client.clear();
});
