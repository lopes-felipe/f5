import type { ApprovalChoice, Item } from "@muse-code/sdk/dist/src/msp.js";
import { describe, expect, it } from "vitest";

import {
  decodeMuseApproval,
  mapMuseApprovalChoices,
  museAnswers,
  museApprovalRequestId,
  museQuestions,
  museRequestType,
  museTodoPlan,
  projectMuseItem,
  salvageMuseDeny,
} from "./MuseEventMapping.ts";

const choice = (choiceId: string, decision: string, scope: string, label = choiceId) =>
  ({ choiceId, decision, scope, label }) as ApprovalChoice;

const item = (overrides: Partial<Item>): Item =>
  ({ itemId: "i1", kind: "agentMessage", revision: 1, status: "inProgress", ...overrides }) as Item;

describe("mapMuseApprovalChoices", () => {
  it("maps each choice kind and keeps Muse's labels", () => {
    expect(
      mapMuseApprovalChoices([
        choice("c1", "approved", "once", "Allow once"),
        choice("c2", "approvedForSession", "session", "Allow for this session"),
        choice("c3", "approvedPolicyAmendment", "localPersistent", "Always allow"),
        choice("c4", "denied", "once", "Deny"),
        choice("c5", "abort", "once", "Stop"),
        choice("c6", "somethingNew", "once"),
      ]),
    ).toEqual([
      { decision: "accept", choiceId: "c1", label: "Allow once" },
      { decision: "acceptForSession", choiceId: "c2", label: "Allow for this session" },
      { decision: "acceptAlways", choiceId: "c3", label: "Always allow" },
      { decision: "decline", choiceId: "c4", label: "Deny" },
      { decision: "cancel", choiceId: "c5", label: "Stop" },
    ]);
  });

  it("keeps the first choice per decision", () => {
    expect(
      mapMuseApprovalChoices([choice("a", "denied", "once"), choice("b", "denied", "session")]),
    ).toEqual([{ decision: "decline", choiceId: "a", label: "a" }]);
  });
});

describe("approval identity and salvage", () => {
  it("builds one request id per stage", () => {
    expect(museApprovalRequestId("ap1", { approvalId: "ap1", sourceIndex: 2 })).toBe("ap1#ap1:2");
  });

  it("decodes a well-formed approval and rejects a malformed one", () => {
    const valid = {
      approvalId: "ap1",
      currentRequirementId: { approvalId: "ap1", sourceIndex: 0 },
      availableChoices: [choice("c1", "approved", "once")],
      subject: { kind: "command", command: "rm -rf build" },
      toolName: "shell",
      turnId: "t1",
    };
    expect(decodeMuseApproval(valid)?.approvalId).toBe("ap1");
    expect(decodeMuseApproval({ ...valid, subject: "nope" })).toBeUndefined();
    expect(
      decodeMuseApproval({ ...valid, subagentOrigin: { subagentId: "child" } })?.subagentOrigin,
    ).toEqual({ subagentId: "child" });
    for (const subagentOrigin of [
      null,
      {},
      { subagentId: " " },
      { subagentId: "x".repeat(1025) },
      { subagentId: "child", childRunId: 42 },
    ]) {
      expect(decodeMuseApproval({ ...valid, subagentOrigin })).toBeUndefined();
    }
  });

  it("salvages a deny choice from an otherwise undecodable approval", () => {
    expect(
      salvageMuseDeny({
        approvalId: "ap1",
        currentRequirementId: { approvalId: "ap1", sourceIndex: 0 },
        availableChoices: [{ choiceId: "d", decision: "denied" }],
      }),
    ).toEqual({
      approvalId: "ap1",
      requirementId: { approvalId: "ap1", sourceIndex: 0 },
      choiceId: "d",
    });
    expect(salvageMuseDeny({ approvalId: "ap1" })).toBeUndefined();
  });

  it("classifies subjects", () => {
    expect(museRequestType({ subject: { kind: "command" }, toolName: "shell" })).toBe(
      "exec_command_approval",
    );
    expect(museRequestType({ subject: { kind: "fileWrite" }, toolName: "edit" })).toBe(
      "file_change_approval",
    );
    expect(museRequestType({ subject: { kind: "fileRead" }, toolName: "read" })).toBe(
      "file_read_approval",
    );
    expect(museRequestType({ subject: { kind: "network", host: "x" }, toolName: "net" })).toBe(
      "permissions_approval",
    );
  });
});

describe("projectMuseItem", () => {
  it("projects assistant text, skips user messages, and generalizes unknown kinds", () => {
    expect(projectMuseItem(item({ text: "Hello", status: "completed" }))).toMatchObject({
      itemType: "assistant_message",
      status: "completed",
      detail: "Hello",
    });
    expect(projectMuseItem(item({ kind: "userMessage" }))).toBeUndefined();
    expect(projectMuseItem(item({ kind: "brandNewKind", label: "Thing" }))).toMatchObject({
      itemType: "dynamic_tool_call",
      title: "Thing",
    });
    expect(
      projectMuseItem(item({ kind: "toolCall", tool: "shell", commandText: "ls" })),
    ).toMatchObject({ itemType: "command_execution", detail: "ls" });
    expect(
      projectMuseItem(item({ kind: "toolCall", tool: "apply_patch", status: "rejected" })),
    ).toMatchObject({ itemType: "file_change", status: "declined" });
  });
});

describe("questions and answers", () => {
  const questions = [
    {
      id: "q1",
      header: "Pick",
      question: "Which one?",
      options: [{ label: "A" }, { label: "B", description: "the b" }],
      selection: { mode: "single" as const },
    },
    {
      id: "q2",
      header: "Many",
      question: "Which ones?",
      options: [{ label: "X" }],
      selection: { mode: "multiple" as const, minSelections: 0 },
    },
  ];

  it("maps MSP questions to F5 questions", () => {
    expect(museQuestions(questions)).toEqual([
      {
        id: "q1",
        header: "Pick",
        question: "Which one?",
        options: [
          { label: "A", description: "A" },
          { label: "B", description: "the b" },
        ],
      },
      {
        id: "q2",
        header: "Many",
        question: "Which ones?",
        options: [{ label: "X", description: "X" }],
        multiSelect: true,
        optional: true,
      },
    ]);
  });

  it("maps labels, label lists and free text", () => {
    expect(museAnswers(questions, { q1: "B", q2: ["X"] })).toEqual([
      { questionId: "q1", selectedLabel: "B" },
      { questionId: "q2", selectedLabels: ["X"] },
    ]);
    expect(museAnswers(questions, { q1: "something else" })).toEqual([
      { questionId: "q1", freeText: "something else" },
    ]);
  });
});

it("maps the todo list to a plan", () => {
  expect(
    museTodoPlan([
      { text: "one", status: "completed" },
      { text: "two", status: "inProgress" },
      { text: "three", status: "pending" },
      { text: "gone", status: "cancelled" },
    ]),
  ).toEqual([
    { step: "one", status: "completed" },
    { step: "two", status: "inProgress" },
    { step: "three", status: "pending" },
  ]);
});
