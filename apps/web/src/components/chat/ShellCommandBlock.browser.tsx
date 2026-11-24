import "../../index.css";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { ShellCommandBlock } from "./ShellCommandBlock";

afterEach(() => document.body.replaceChildren());

it("preserves the exact command while shell and embedded grammars load", async () => {
  const command = "python3 <<'PY'\r\nprint('hello')\r\nPY";
  const screen = await render(
    <pre data-testid="command">
      <ShellCommandBlock command={command} />
    </pre>,
  );
  const element = screen.getByTestId("command").element();
  expect(element.textContent).toBe(command);
  await expect.poll(() => element.querySelectorAll("span[style]").length).toBeGreaterThan(0);
  expect(element.textContent).toBe(command);
});

it("uses bounded lightweight coloring for large commands without losing their text", async () => {
  const command = "echo x\n".repeat(5000);
  const screen = await render(
    <pre data-testid="command">
      <ShellCommandBlock command={command} />
    </pre>,
  );
  const element = screen.getByTestId("command").element();
  expect(element.textContent).toBe(command);
  expect(element.querySelectorAll("span[style]").length).toBe(0);
  expect(element.querySelector(".text-info-foreground")).not.toBeNull();
  expect(element.querySelectorAll("span").length).toBeLessThan(10_000);
});
