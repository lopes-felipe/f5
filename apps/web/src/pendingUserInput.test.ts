import { describe, expect, it } from "vitest";

import {
  buildPendingUserInputAnswers,
  countAnsweredPendingUserInputQuestions,
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOption,
} from "./pendingUserInput";

describe("resolvePendingUserInputAnswer", () => {
  it("prefers a custom answer over a selected option", () => {
    expect(
      resolvePendingUserInputAnswer({
        selectedOptionLabels: ["Keep current envelope"],
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("falls back to a single selected option", () => {
    expect(
      resolvePendingUserInputAnswer({
        selectedOptionLabels: ["Scaffold only"],
      }),
    ).toBe("Scaffold only");
  });

  it("returns an array when multiple options are selected", () => {
    expect(
      resolvePendingUserInputAnswer({
        selectedOptionLabels: ["Frontend", "Backend"],
      }),
    ).toEqual(["Frontend", "Backend"]);
  });

  it("preserves labels that contain a comma separator", () => {
    // Previously the UI joined labels with ", " which silently collapsed
    // "Docker, Compose v2" into two separate labels on the receiver side.
    expect(
      resolvePendingUserInputAnswer({
        selectedOptionLabels: ["Docker, Compose v2", "Podman"],
      }),
    ).toEqual(["Docker, Compose v2", "Podman"]);
  });

  it("clears the preset selection when a custom answer is entered", () => {
    expect(
      setPendingUserInputCustomAnswer(
        {
          selectedOptionLabels: ["Preserve existing tags"],
        },
        "doesn't matter",
      ),
    ).toEqual({
      customAnswer: "doesn't matter",
    });
  });

  it("returns null for an empty draft", () => {
    expect(resolvePendingUserInputAnswer(undefined)).toBeNull();
    expect(resolvePendingUserInputAnswer({})).toBeNull();
    expect(resolvePendingUserInputAnswer({ selectedOptionLabels: [] })).toBeNull();
  });
});

describe("togglePendingUserInputOption", () => {
  it("adds a new option when not present", () => {
    expect(togglePendingUserInputOption(undefined, "Frontend")).toEqual({
      selectedOptionLabels: ["Frontend"],
    });
  });

  it("appends to the existing selection in order", () => {
    expect(togglePendingUserInputOption({ selectedOptionLabels: ["Frontend"] }, "Backend")).toEqual(
      { selectedOptionLabels: ["Frontend", "Backend"] },
    );
  });

  it("removes an option when toggled off", () => {
    expect(
      togglePendingUserInputOption({ selectedOptionLabels: ["Frontend", "Backend"] }, "Frontend"),
    ).toEqual({ selectedOptionLabels: ["Backend"] });
  });

  it("returns an empty draft when the last option is removed", () => {
    expect(
      togglePendingUserInputOption({ selectedOptionLabels: ["Frontend"] }, "Frontend"),
    ).toEqual({});
  });

  it("clears any custom answer when toggled (selection wins)", () => {
    expect(
      togglePendingUserInputOption(
        { selectedOptionLabels: ["Frontend"], customAnswer: "free text" },
        "Backend",
      ),
    ).toEqual({ selectedOptionLabels: ["Frontend", "Backend"] });
  });
});

describe("buildPendingUserInputAnswers", () => {
  it("returns a canonical answer map for complete prompts", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          {
            id: "scope",
            header: "Scope",
            question: "What should the plan target first?",
            options: [
              {
                label: "Orchestration-first",
                description: "Focus on orchestration first",
              },
            ],
          },
          {
            id: "compat",
            header: "Compat",
            question: "How strict should compatibility be?",
            options: [
              {
                label: "Keep current envelope",
                description: "Preserve current wire format",
              },
            ],
          },
        ],
        {
          scope: {
            selectedOptionLabels: ["Orchestration-first"],
          },
          compat: {
            customAnswer: "Keep the current envelope for one release window",
          },
        },
      ),
    ).toEqual({
      scope: "Orchestration-first",
      compat: "Keep the current envelope for one release window",
    });
  });

  it("carries multi-select answers through as an array", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          {
            id: "tags",
            header: "Tags",
            question: "Pick all that apply",
            options: [
              { label: "Frontend", description: "Frontend" },
              { label: "Backend", description: "Backend" },
            ],
            multiSelect: true,
          },
        ],
        {
          tags: { selectedOptionLabels: ["Frontend", "Backend"] },
        },
      ),
    ).toEqual({ tags: ["Frontend", "Backend"] });
  });

  it("returns null when any question is unanswered", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          {
            id: "scope",
            header: "Scope",
            question: "What should the plan target first?",
            options: [
              {
                label: "Orchestration-first",
                description: "Focus on orchestration first",
              },
            ],
          },
        ],
        {},
      ),
    ).toBeNull();
  });
});

describe("pending user input question progress", () => {
  const questions = [
    {
      id: "scope",
      header: "Scope",
      question: "What should the plan target first?",
      options: [
        {
          label: "Orchestration-first",
          description: "Focus on orchestration first",
        },
      ],
    },
    {
      id: "compat",
      header: "Compat",
      question: "How strict should compatibility be?",
      options: [
        {
          label: "Keep current envelope",
          description: "Preserve current wire format",
        },
      ],
    },
  ] as const;

  it("counts only answered questions", () => {
    expect(
      countAnsweredPendingUserInputQuestions(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("finds the first unanswered question", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("returns the last question index when all answers are complete", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
        compat: {
          customAnswer: "Keep it for one release window",
        },
      }),
    ).toBe(1);
  });

  it("derives the active question and advancement state", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: {
            selectedOptionLabels: ["Orchestration-first"],
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: questions[0],
      selectedOptionLabels: ["Orchestration-first"],
      customAnswer: "",
      resolvedAnswer: "Orchestration-first",
      answeredQuestionCount: 1,
      isLastQuestion: false,
      isComplete: false,
      canAdvance: true,
    });
  });
});
