import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { serverQueryKeys } from "../../lib/serverReactQuery";
import { VscodeEntryIcon } from "./VscodeEntryIcon";

async function renderIcon(doNotTrack: boolean | undefined) {
  const client = new QueryClient();
  client.setQueryData(
    serverQueryKeys.config(),
    doNotTrack === undefined ? {} : { privacy: { doNotTrack } },
  );
  return render(
    <QueryClientProvider client={client}>
      <div data-testid="icon">
        <VscodeEntryIcon pathValue="src/index.ts" kind="file" theme="dark" />
      </div>
    </QueryClientProvider>,
  );
}

it("loads the file icon from the CDN by default", async () => {
  const screen = await renderIcon(undefined);
  const image = screen.container.querySelector("img");
  expect(image?.getAttribute("src")).toContain("cdn.jsdelivr.net");
});

it("renders a local icon and makes no CDN request while DO_NOT_TRACK is set", async () => {
  const screen = await renderIcon(true);
  expect(screen.container.querySelector("img")).toBeNull();
  expect(screen.container.querySelector("svg")).not.toBeNull();
  expect(screen.container.innerHTML).not.toContain("jsdelivr");
});
