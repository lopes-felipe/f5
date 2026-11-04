import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { Button } from "./button";
import { Group } from "./group";
import { Toggle } from "./toggle";

// These run on index.css's default tokens, where `secondary` and `accent` are
// the same value, so a state that relied on `accent` would not show here.

function styleOf(locator: { element(): Element }) {
  return getComputedStyle(locator.element() as HTMLElement);
}

describe("quiet tonal controls", () => {
  it("tells a pressed outline toggle from an unpressed one", async () => {
    await render(
      <div>
        <Toggle variant="outline" pressed aria-label="On" />
        <Toggle variant="outline" pressed={false} aria-label="Off" />
      </div>,
    );
    const on = page.getByRole("button", { name: "On" });
    const off = page.getByRole("button", { name: "Off" });

    await expect.poll(() => styleOf(on).backgroundColor).not.toBe(styleOf(off).backgroundColor);
    expect(styleOf(on).color).not.toBe(styleOf(off).color);
  });

  it("shows hover on an outline button", async () => {
    await render(<Button variant="outline">Hover me</Button>);
    const button = page.getByRole("button", { name: "Hover me" });
    const resting = styleOf(button).backgroundColor;

    await userEvent.hover(button);
    await expect.poll(() => styleOf(button).backgroundColor).not.toBe(resting);
    // Later fixtures render where this button was; leave the pointer off them.
    await userEvent.unhover(button);
  });

  it("keeps solid buttons solid in a default (joined) group", async () => {
    await render(
      <Group aria-label="Joined">
        <Button>Open</Button>
        <Button aria-label="More">v</Button>
      </Group>,
    );
    const open = page.getByRole("button", { name: "Open" });
    expect(styleOf(open).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  it("renders track segments at 24px with a transparent resting fill", async () => {
    await render(
      <Group aria-label="Track" variant="track">
        <Button variant="ghost" size="sm">
          Run
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Options">
          v
        </Button>
      </Group>,
    );
    for (const name of ["Run", "Options"]) {
      const segment = page.getByRole("button", { name });
      expect((segment.element() as HTMLElement).getBoundingClientRect().height).toBe(24);
      expect(styleOf(segment).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    }
  });
});
