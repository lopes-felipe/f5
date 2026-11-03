import { expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { IntervalSecondsField } from "./IntervalSecondsField";
import { StrictMode, useState } from "react";
import { act } from "react";

it("preserves newer typing when an earlier save is acknowledged", async () => {
  let finish!: () => void;
  const commit = vi.fn();
  function Harness() {
    const [value, setValue] = useState(300);
    return (
      <IntervalSecondsField
        value={value}
        min={5}
        max={3600}
        step={5}
        disabled={false}
        label="Interval"
        onCommit={(seconds) => {
          commit(seconds);
          return new Promise<void>((resolve) => {
            finish = () => {
              setValue(seconds);
              resolve();
            };
          });
        }}
      />
    );
  }
  const screen = await render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
  const input = screen.getByRole("spinbutton", { name: "Interval" });
  await input.fill("120");
  await userEvent.keyboard("{Enter}");
  expect(commit).toHaveBeenCalledExactlyOnceWith(120);
  await input.fill("150");
  await act(async () => finish());
  await expect.element(input).toHaveValue(150);
  await userEvent.tab();
  expect(commit.mock.calls.map(([seconds]) => seconds)).toEqual([120, 150]);
  await act(async () => finish());
});

it("keeps a newer draft when an earlier save fails", async () => {
  let reject!: (error: Error) => void;
  const onCommit = vi.fn(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  const screen = await render(
    <IntervalSecondsField
      value={300}
      min={5}
      max={3600}
      step={5}
      disabled={false}
      label="Interval"
      onCommit={onCommit}
    />,
  );
  const input = screen.getByRole("spinbutton", { name: "Interval" });
  await input.fill("120");
  await userEvent.tab();
  await input.fill("150");
  reject(new Error("Offline"));
  await expect.element(input).toHaveValue(150);
});

it("saves only on blur, restores empty drafts and clamps completed values", async () => {
  const onCommit = vi.fn();
  const screen = await render(
    <IntervalSecondsField
      value={300}
      min={5}
      max={3600}
      step={5}
      disabled={false}
      label="Interval"
      onCommit={onCommit}
    />,
  );
  const input = screen.getByRole("spinbutton", { name: "Interval" });
  await input.fill("120");
  expect(onCommit).not.toHaveBeenCalled();
  await userEvent.tab();
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(120);
  onCommit.mockClear();
  await input.fill("");
  await userEvent.tab();
  await expect.element(input).toHaveValue(300);
  expect(onCommit).not.toHaveBeenCalled();
  await input.fill("1");
  await userEvent.tab();
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(5);
});

it("restores rejected writes and permits retrying the same value", async () => {
  const onCommit = vi.fn().mockRejectedValue(new Error("Offline"));
  const screen = await render(
    <IntervalSecondsField
      value={300}
      min={5}
      max={3600}
      step={5}
      disabled={false}
      label="Interval"
      onCommit={onCommit}
    />,
  );
  const input = screen.getByRole("spinbutton", { name: "Interval" });
  await input.fill("120");
  await userEvent.tab();
  await expect.element(input).toHaveValue(300);
  await input.fill("120");
  await userEvent.tab();
  expect(onCommit).toHaveBeenCalledTimes(2);
});
