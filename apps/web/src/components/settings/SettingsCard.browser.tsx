import "../../index.css";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { SettingsRow } from "./SettingsCard";

it("keeps long descriptions beside controls at normal widths in both row variants", async () => {
  const view = await render(
    <div style={{ width: 700 }}>
      {[false, true].map((withChildren) => (
        <SettingsRow
          key={String(withChildren)}
          title="Setting title"
          description={"A long description that should wrap within its own column. ".repeat(8)}
          control={<button>Change setting</button>}
        >
          {withChildren ? <div>Editor</div> : undefined}
        </SettingsRow>
      ))}
    </div>,
  );
  try {
    const titles = [...document.querySelectorAll("p")].filter(
      (p) => p.textContent === "Setting title",
    );
    const controls = [...document.querySelectorAll("button")].filter(
      (b) => b.textContent === "Change setting",
    );
    for (let i = 0; i < titles.length; i++) {
      const title = titles[i]!.getBoundingClientRect();
      const control = controls[i]!.getBoundingClientRect();
      expect(control.left).toBeGreaterThan(title.right);
      expect(control.top).toBeLessThan(titles[i]!.parentElement!.getBoundingClientRect().bottom);
    }
  } finally {
    await view.unmount();
  }
});
