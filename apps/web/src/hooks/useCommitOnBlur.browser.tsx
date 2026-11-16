import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { resolvePastedPath } from "@t3tools/shared/path";
import { DraftInput } from "../components/ui/draft-input";
import { useCommitOnBlur } from "./useCommitOnBlur";

describe("settings draft commits", () => {
  it("preserves external updates when an untouched field blurs", async () => {
    const commit = vi.fn();
    const view = await render(<DraftInput value="~/" onCommit={commit} />);
    try {
      const input = page.getByRole("textbox");
      await input.click();
      await view.rerender(<DraftInput value="/projects" onCommit={commit} />);
      await userEvent.tab();
      expect(commit).not.toHaveBeenCalled();
      await expect.element(input).toHaveValue("/projects");
    } finally {
      await view.unmount();
    }
  });

  it("does not save again when refocused before the snapshot arrives", async () => {
    const commit = vi.fn();
    const view = await render(<DraftInput value="~/" onCommit={commit} />);
    try {
      const input = page.getByRole("textbox");
      await input.fill("/projects");
      await userEvent.tab();
      expect(commit).toHaveBeenCalledExactlyOnceWith("/projects");
      await input.click();
      await view.rerender(<DraftInput value="/projects" onCommit={commit} />);
      await userEvent.tab();
      expect(commit).toHaveBeenCalledTimes(1);
    } finally {
      await view.unmount();
    }
  });

  it("commits edits over external updates but skips an edit reverted to its focus value", async () => {
    const commit = vi.fn();
    const view = await render(<DraftInput value="~/" onCommit={commit} />);
    try {
      const input = page.getByRole("textbox");
      await input.fill("/mine");
      await view.rerender(<DraftInput value="/external" onCommit={commit} />);
      await userEvent.tab();
      expect(commit).toHaveBeenCalledExactlyOnceWith("/mine");
      await input.fill("/other");
      await input.fill("/mine");
      await userEvent.tab();
      expect(commit).toHaveBeenCalledTimes(1);
    } finally {
      await view.unmount();
    }
  });

  it("normalizes changes against the preceding draft and preserves ordinary typing", async () => {
    const commit = vi.fn();
    const view = await render(
      <DraftInput value="/mnt/old/" onCommit={commit} normalizeDraft={resolvePastedPath} />,
    );
    try {
      const input = page.getByRole("textbox");
      await input.fill("/mnt/old//mnt/new");
      await userEvent.tab();
      expect(commit).toHaveBeenLastCalledWith("/mnt/new");
      await input.fill("");
      await userEvent.type(input, "/tmp/a\\ b");
      await userEvent.tab();
      expect(commit).toHaveBeenLastCalledWith("/tmp/a\\ b");
    } finally {
      await view.unmount();
    }
  });

  it("ignores whitespace-only edits with trimming enabled", async () => {
    const commit = vi.fn();
    function Field({ value }: { value: string }) {
      return <textarea {...useCommitOnBlur(value, commit, { trim: true, multiline: true })} />;
    }
    const view = await render(<Field value="old" />);
    try {
      await page.getByRole("textbox").fill(" old ");
      await view.rerender(<Field value="new" />);
      await userEvent.tab();
      expect(commit).not.toHaveBeenCalled();
      await expect.element(page.getByRole("textbox")).toHaveValue("new");
    } finally {
      await view.unmount();
    }
  });
});
