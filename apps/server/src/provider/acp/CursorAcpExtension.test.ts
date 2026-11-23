import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RequestPermissionRequest } from "effect-acp/schema";

import {
  cursorAskQuestionOutcome,
  cursorCreatePlanReply,
  cursorFallbackQuestionReply,
  cursorGeneratedImagePath,
  cursorQuestionFallbackBaseId,
  cursorQuestionFallbackReply,
  extractAskQuestions,
  extractPlanMarkdown,
  extractTodosAsPlan,
  resolveCursorGeneratedImage,
} from "./CursorAcpExtension.ts";

const question = {
  toolCallId: "ask-1",
  questions: [
    {
      id: "scope",
      prompt: "Which scope?",
      options: [
        { id: "a", label: "Same" },
        { id: "b", label: "Same" },
      ],
    },
    {
      id: "langs",
      prompt: "Which languages?",
      allowMultiple: true,
      options: [
        { id: "ts", label: "TypeScript" },
        { id: "rs", label: "Rust" },
      ],
    },
  ],
};

const fallback = (overrides: Partial<RequestPermissionRequest["toolCall"]> = {}) =>
  ({
    sessionId: "s",
    toolCall: { toolCallId: "ask-1_q0", kind: "other", title: "Which scope?", ...overrides },
    options: [
      { optionId: "allow-once", name: "Allow", kind: "allow_once" },
      { optionId: "reject-once", name: "Skip", kind: "reject_once" },
    ],
  }) satisfies RequestPermissionRequest;

describe("CursorAcpExtension", () => {
  it("extracts ask-question prompts from the real Cursor ACP payload shape", () => {
    const questions = extractAskQuestions({
      toolCallId: "ask-1",
      title: "Need input",
      questions: [
        {
          id: "language",
          prompt: "Which language should I use?",
          options: [
            { id: "ts", label: "TypeScript" },
            { id: "rs", label: "Rust" },
          ],
          allowMultiple: false,
        },
      ],
    });

    expect(questions).toEqual([
      {
        id: "language",
        header: "Question",
        question: "Which language should I use?",
        multiSelect: false,
        allowCustomAnswer: false,
        options: [
          { label: "TypeScript", description: "TypeScript", value: "ts" },
          { label: "Rust", description: "Rust", value: "rs" },
        ],
      },
    ]);
  });

  it("defaults ask-question multi-select to false when Cursor omits allowMultiple", () => {
    const questions = extractAskQuestions({
      toolCallId: "ask-2",
      questions: [
        {
          id: "mode",
          prompt: "Which mode should I use?",
          options: [
            { id: "agent", label: "Agent" },
            { id: "plan", label: "Plan" },
          ],
        },
      ],
    });

    expect(questions).toEqual([
      {
        id: "mode",
        header: "Question",
        question: "Which mode should I use?",
        multiSelect: false,
        allowCustomAnswer: false,
        options: [
          { label: "Agent", description: "Agent", value: "agent" },
          { label: "Plan", description: "Plan", value: "plan" },
        ],
      },
    ]);
  });

  it("extracts plan markdown from the real Cursor create-plan payload shape", () => {
    const planMarkdown = extractPlanMarkdown({
      toolCallId: "plan-1",
      name: "Refactor parser",
      overview: "Tighten ACP parsing",
      plan: "# Plan\n\n1. Add schemas\n2. Remove casts",
      todos: [
        { id: "t1", content: "Add schemas", status: "in_progress" },
        { id: "t2", content: "Remove casts", status: "pending" },
      ],
      isProject: false,
    });

    expect(planMarkdown).toBe("# Plan\n\n1. Add schemas\n2. Remove casts");
  });

  it("projects todo updates into a plan shape and drops invalid entries", () => {
    expect(
      extractTodosAsPlan({
        toolCallId: "todos-1",
        todos: [
          { id: "1", content: "Inspect state", status: "completed" },
          { id: "2", content: "  Apply fix  ", status: "in_progress" },
          { id: "3", title: "Fallback title", status: "pending" },
          { id: "4", content: "Unknown status", status: "weird_status" },
          { id: "5", content: "   " },
        ],
        merge: true,
      }),
    ).toEqual({
      plan: [
        { step: "Inspect state", status: "completed" },
        { step: "Apply fix", status: "inProgress" },
        { step: "Fallback title", status: "pending" },
        { step: "Unknown status", status: "pending" },
      ],
    });
  });

  it("answers by option id so duplicate labels stay distinct", () => {
    expect(cursorAskQuestionOutcome(question, { scope: "b", langs: ["ts", "rs"] })).toEqual({
      outcome: "answered",
      answers: [
        { questionId: "scope", selectedOptionIds: ["b"] },
        { questionId: "langs", selectedOptionIds: ["ts", "rs"] },
      ],
    });
  });

  it("keeps single-select questions to one option and accepts legacy label answers", () => {
    expect(cursorAskQuestionOutcome(question, { scope: ["Same", "b"] })).toEqual({
      outcome: "answered",
      answers: [
        { questionId: "scope", selectedOptionIds: ["a"] },
        { questionId: "langs", selectedOptionIds: [] },
      ],
    });
  });

  it("treats a dismissed card as skipped", () => {
    expect(cursorAskQuestionOutcome(question, {}).outcome).toBe("skipped");
    expect(cursorAskQuestionOutcome(question, { scope: "unknown" }).outcome).toBe("skipped");
  });

  it("recognises only the question fallback permission shape", () => {
    expect(cursorQuestionFallbackBaseId(fallback())).toBe("ask-1");
    expect(cursorQuestionFallbackBaseId(fallback({ kind: "execute" }))).toBeUndefined();
    expect(cursorQuestionFallbackBaseId(fallback({ toolCallId: "ask-1" }))).toBeUndefined();
    expect(
      cursorQuestionFallbackBaseId({
        ...fallback(),
        options: [{ optionId: "always", name: "Always", kind: "allow_always" }],
      }),
    ).toBeUndefined();
  });

  it("maps a settled question onto the fallback's options", () => {
    const allowRust = {
      ...fallback(),
      options: [
        { optionId: "allow-once", name: "Rust", kind: "allow_once" },
        { optionId: "reject-once", name: "Skip", kind: "reject_once" },
      ],
    } satisfies RequestPermissionRequest;
    expect(
      cursorQuestionFallbackReply(
        allowRust,
        { outcome: "answered", answers: [{ questionId: "langs", selectedOptionIds: ["rs"] }] },
        question,
      ),
    ).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
    expect(cursorQuestionFallbackReply(fallback(), { outcome: "skipped" }, question)).toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
    expect(cursorQuestionFallbackReply(fallback(), { outcome: "cancelled" }, question)).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  it("re-asks instead of guessing when a settled answer is ambiguous", () => {
    // Several questions: which one `_q<n>` re-asks, and whether it was the
    // skipped one, is not recorded, so nothing is replayed.
    expect(
      cursorQuestionFallbackReply(
        fallback(),
        {
          outcome: "answered",
          answers: [
            { questionId: "scope", selectedOptionIds: [] },
            { questionId: "langs", selectedOptionIds: ["rs"] },
          ],
        },
        question,
      ),
    ).toBeUndefined();
    // The chosen label differs from the `allow_once` option's name: the
    // option may stand for a choice the user rejected.
    expect(
      cursorQuestionFallbackReply(
        fallback(),
        { outcome: "answered", answers: [{ questionId: "langs", selectedOptionIds: ["rs"] }] },
        question,
      ),
    ).toBeUndefined();
    // A multi-select answer never maps onto one option.
    expect(
      cursorQuestionFallbackReply(
        {
          ...fallback(),
          options: [
            { optionId: "allow-once", name: "Rust", kind: "allow_once" },
            { optionId: "reject-once", name: "Skip", kind: "reject_once" },
          ],
        },
        {
          outcome: "answered",
          answers: [{ questionId: "langs", selectedOptionIds: ["ts", "rs"] }],
        },
        question,
      ),
    ).toBeUndefined();
    // One `allow_once` option per choice: the pick cannot be mapped.
    expect(
      cursorQuestionFallbackReply(
        {
          ...fallback(),
          options: [
            { optionId: "first", name: "TypeScript", kind: "allow_once" },
            { optionId: "second", name: "Rust", kind: "allow_once" },
            { optionId: "reject-once", name: "Skip", kind: "reject_once" },
          ],
        },
        { outcome: "answered", answers: [{ questionId: "langs", selectedOptionIds: ["rs"] }] },
        question,
      ),
    ).toBeUndefined();
    // Without the original question there is no label to match.
    expect(
      cursorQuestionFallbackReply(
        fallback(),
        { outcome: "answered", answers: [{ questionId: "scope", selectedOptionIds: ["a"] }] },
        undefined,
      ),
    ).toBeUndefined();
  });

  it("answers an unknown fallback from its own question card", () => {
    expect(cursorFallbackQuestionReply(fallback(), { "ask-1_q0": "allow-once" })).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    expect(cursorFallbackQuestionReply(fallback(), {})).toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
    expect(cursorFallbackQuestionReply(fallback(), "cancelled")).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  it("keeps the legacy plan reply until the live gate certifies an outcome", () => {
    expect(cursorCreatePlanReply(undefined)).toEqual({ accepted: true });
    expect(cursorCreatePlanReply("cancelled")).toEqual({ outcome: { outcome: "cancelled" } });
    expect(cursorCreatePlanReply("rejected")).toMatchObject({ outcome: { outcome: "rejected" } });
  });

  it("shows generated images only from the workspace or attachments directory", () => {
    expect(cursorGeneratedImagePath("out/a.png", "/work", "/state/attachments")).toBe(
      "/work/out/a.png",
    );
    expect(
      cursorGeneratedImagePath("/state/attachments/b.webp", "/work", "/state/attachments"),
    ).toBe("/state/attachments/b.webp");
    expect(
      cursorGeneratedImagePath("../escape.png", "/work", "/state/attachments"),
    ).toBeUndefined();
    expect(cursorGeneratedImagePath("/etc/passwd", "/work", "/state/attachments")).toBeUndefined();
    expect(cursorGeneratedImagePath("notes.txt", "/work", "/state/attachments")).toBeUndefined();
  });

  it("rejects a workspace image symlink that points outside", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-image-")));
    try {
      const workspace = join(root, "workspace");
      const outside = join(root, "outside");
      await mkdir(workspace);
      await mkdir(outside);
      await writeFile(join(workspace, "real.png"), "");
      await writeFile(join(outside, "secret.png"), "");
      await symlink(join(outside, "secret.png"), join(workspace, "linked.png"));
      const attachments = join(root, "attachments");
      expect(await resolveCursorGeneratedImage("real.png", workspace, attachments)).toBe(
        join(workspace, "real.png"),
      );
      expect(
        await resolveCursorGeneratedImage("linked.png", workspace, attachments),
      ).toBeUndefined();
      expect(
        await resolveCursorGeneratedImage("missing.png", workspace, attachments),
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
