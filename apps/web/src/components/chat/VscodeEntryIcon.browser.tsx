import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { serverQueryKeys } from "../../lib/serverReactQuery";
import { VscodeEntryIcon } from "./VscodeEntryIcon";

async function renderIcon(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <div data-testid="icon">
        <VscodeEntryIcon pathValue="src/index.ts" kind="file" theme="dark" />
      </div>
    </QueryClientProvider>,
  );
}

function clientWithConfig(config: object) {
  const client = new QueryClient();
  client.setQueryData(serverQueryKeys.config(), config);
  return client;
}

it("loads the file icon from the CDN for a server config without privacy settings", async () => {
  // Servers older than DO_NOT_TRACK support omit `privacy`.
  const screen = await renderIcon(clientWithConfig({}));
  const image = screen.container.querySelector("img");
  expect(image?.getAttribute("src")).toContain("cdn.jsdelivr.net");
});

it("renders a local icon and makes no CDN request while DO_NOT_TRACK is set", async () => {
  const screen = await renderIcon(clientWithConfig({ privacy: { doNotTrack: true } }));
  expect(screen.container.querySelector("img")).toBeNull();
  expect(screen.container.querySelector("svg")).not.toBeNull();
  expect(screen.container.innerHTML).not.toContain("jsdelivr");
});

it("makes no CDN request before the server config arrives", async () => {
  const client = new QueryClient();
  const screen = await renderIcon(client);
  expect(screen.container.querySelector("img")).toBeNull();
  expect(screen.container.querySelector("svg")).not.toBeNull();

  client.setQueryData(serverQueryKeys.config(), { privacy: { doNotTrack: false } });
  await expect
    .poll(() => screen.container.querySelector("img")?.getAttribute("src"))
    .toContain("cdn.jsdelivr.net");
});
