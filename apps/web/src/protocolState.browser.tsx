import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import {
  resetProtocolStateForTests,
  setServerBootstrap,
  useServerCapability,
} from "./protocolState";
import { serverBootstrapFixture } from "./test/serverBootstrap";

function Capability() {
  return (
    <output aria-label="Composer capability">
      {String(useServerCapability("composer-redesign"))}
    </output>
  );
}

afterEach(resetProtocolStateForTests);

it("keeps the capability off until bootstrap arrives and follows subsequent bootstrap changes", async () => {
  resetProtocolStateForTests();
  await render(<Capability />);
  await expect.element(page.getByLabelText("Composer capability")).toHaveTextContent("false");
  setServerBootstrap({
    ...serverBootstrapFixture,
    capabilities: [...serverBootstrapFixture.capabilities, "composer-redesign"],
  });
  await expect.element(page.getByLabelText("Composer capability")).toHaveTextContent("true");
  setServerBootstrap(serverBootstrapFixture);
  await expect.element(page.getByLabelText("Composer capability")).toHaveTextContent("false");
});
