import "../../index.css";

import { useState } from "react";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { UserInputQuestionStep } from "./UserInputQuestionStep";

it("wraps a long header when expanded and truncates it when collapsed", async () => {
  const header = "LongQuestionHeader".repeat(6);
  const screen = await render(
    <div className="w-60">
      <UserInputQuestionStep
        question={{ id: "long-header", header, question: "Choose", options: [], multiSelect: true }}
        questionIndex={0}
        questionCount={1}
        selectedOptionLabels={[]}
        disabled={false}
        customMode="composer"
        shortcutScope="document"
        onSelectOption={() => {}}
        onToggleOption={() => {}}
        onAdvance={() => {}}
      />
    </div>,
  );
  try {
    const toggle = page.getByRole("button", { name: new RegExp(header) });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
    const label = page.getByText(header, { exact: true }).element() as HTMLElement;
    const expandedHeight = label.offsetHeight;
    expect(label.scrollWidth).toBe(label.clientWidth);

    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    expect(label.offsetHeight).toBeLessThan(expandedHeight);
    expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
    expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
  } finally {
    await screen.unmount();
  }
});

it("hides custom answers for provider option-only questions", async () => {
  const screen = await render(
    <UserInputQuestionStep
      question={{
        id: "branch",
        header: "Branch",
        question: "Choose",
        options: [{ label: "Main", description: "main", value: "opt-main" }],
        allowCustomAnswer: false,
      }}
      questionIndex={0}
      questionCount={1}
      selectedOptionLabels={[]}
      disabled={false}
      customMode="inline"
      customOpen
      shortcutScope="panel"
      onSelectOption={() => {}}
      onToggleOption={() => {}}
      onAdvance={() => {}}
    />,
  );
  try {
    await expect.element(page.getByRole("button", { name: /Main/ })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Other…" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("textbox")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

function Questions() {
  const [index, setIndex] = useState(0);
  const [disabled, setDisabled] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const id = "question-" + index;
  return (
    <>
      <output aria-label="Current question">{index}</output>
      <button onClick={() => setIndex(index + 1)}>Next</button>
      <button onClick={() => setIndex(index - 1)}>Back</button>
      <button onClick={() => setDisabled(!disabled)}>Toggle disabled</button>
      <UserInputQuestionStep
        question={{
          id,
          header: "Question",
          question: "Choose",
          options: [{ label: "Option", description: "Select this" }],
        }}
        questionIndex={index}
        questionCount={3}
        disabled={disabled}
        customMode="composer"
        shortcutScope="panel"
        selectedOptionLabels={answers[id] ? [answers[id]!] : []}
        onSelectOption={(label) => setAnswers({ ...answers, [id]: label })}
        onToggleOption={() => {}}
        onAdvance={() => {
          if (answers[id]) setIndex((current) => current + 1);
        }}
      />
    </>
  );
}

it.each(["Next", "Back", "Toggle disabled"])("cancels delayed advance after %s", async (action) => {
  const screen = await render(<Questions />);
  try {
    (page.getByRole("button", { name: "Option", exact: true }).element() as HTMLElement).click();
    (page.getByRole("button", { name: action, exact: true }).element() as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect
      .element(page.getByLabelText("Current question"))
      .toHaveTextContent(action === "Next" ? "1" : action === "Back" ? "-1" : "0");
  } finally {
    await screen.unmount();
  }
});

it("advances once after the same question's draft rerenders", async () => {
  const screen = await render(<Questions />);
  try {
    await page.getByRole("button", { name: "Option", exact: true }).click();
    await expect.element(page.getByLabelText("Current question")).toHaveTextContent("1");
    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect.element(page.getByLabelText("Current question")).toHaveTextContent("1");
  } finally {
    await screen.unmount();
  }
});
