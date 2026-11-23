import {
  CodeReviewWorkflowId,
  CommandId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { WorkflowProviderSnapshot } from "@t3tools/shared/workflowProviders";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decideOrchestrationCommand } from "./decider.ts";
import { applyArchiveTestCommand, workflowArchiveFixture } from "./workflowArchive.testUtils.ts";

describe("workflow upsert roster rules", () => {
  const planning = () => {
    const fixture = workflowArchiveFixture("planning");
    const workflow = fixture.model.planningWorkflows[0]!;
    const upsert = (next: typeof workflow) =>
      applyArchiveTestCommand(fixture.model, {
        type: "project.workflow.upsert",
        commandId: CommandId.makeUnsafe("planning-upsert"),
        projectId: workflow.projectId,
        workflow: next,
        createdAt: "2026-10-19T11:00:00.000Z",
      });
    return { workflow, upsert };
  };
  const codeReview = () => {
    const fixture = workflowArchiveFixture("codeReview");
    const workflow = fixture.model.codeReviewWorkflows[0]!;
    const upsert = (next: typeof workflow) =>
      applyArchiveTestCommand(fixture.model, {
        type: "project.code-review-workflow.upsert",
        commandId: CommandId.makeUnsafe("code-review-upsert"),
        projectId: workflow.projectId,
        workflow: next,
        updatedAt: "2026-10-19T11:00:00.000Z",
      });
    return { workflow, upsert };
  };

  it("accepts a planning upsert that keeps the roster", () => {
    const { workflow, upsert } = planning();
    expect(() => upsert({ ...workflow, title: "Renamed" })).not.toThrow();
  });

  it("rejects a planning upsert that adds an author", () => {
    const { workflow, upsert } = planning();
    expect(() =>
      upsert({
        ...workflow,
        additionalBranches: [
          {
            ...workflow.branchA,
            branchId: "c",
            authorThreadId: ThreadId.makeUnsafe("archive-c"),
          },
        ],
      }),
    ).toThrow("Workflow upserts cannot add or remove actors.");
  });

  it("rejects a planning upsert that changes an author's model or thread", () => {
    const { workflow, upsert } = planning();
    expect(() =>
      upsert({
        ...workflow,
        branchB: { ...workflow.branchB, authorSlot: { provider: "codex", model: "gpt-5.5" } },
      }),
    ).toThrow("Workflow upserts cannot change an actor's thread or model.");
    expect(() =>
      upsert({
        ...workflow,
        branchB: { ...workflow.branchB, authorThreadId: ThreadId.makeUnsafe("archive-other") },
      }),
    ).toThrow("Workflow upserts cannot change an actor's thread or model.");
  });

  it("rejects a planning upsert that swaps the branch ids", () => {
    const { workflow, upsert } = planning();
    expect(() =>
      upsert({
        ...workflow,
        branchA: { ...workflow.branchA, branchId: "b" },
        branchB: { ...workflow.branchB, branchId: "a" },
      }),
    ).toThrow("Workflow branches must preserve branch ids 'a' and 'b'.");
  });

  it("accepts a code review upsert that keeps the roster", () => {
    const { workflow, upsert } = codeReview();
    expect(() =>
      upsert({ ...workflow, reviewerA: { ...workflow.reviewerA, status: "running" } }),
    ).not.toThrow();
  });

  it("rejects a code review upsert that adds a reviewer", () => {
    const { workflow, upsert } = codeReview();
    expect(() =>
      upsert({
        ...workflow,
        additionalReviewers: [
          { ...workflow.reviewerA, threadId: ThreadId.makeUnsafe("archive-c"), label: "C" },
        ],
      }),
    ).toThrow("Workflow upserts cannot add or remove actors.");
  });

  it("rejects a code review upsert that changes a reviewer's model", () => {
    const { workflow, upsert } = codeReview();
    expect(() =>
      upsert({
        ...workflow,
        reviewerB: { ...workflow.reviewerB, slot: { provider: "codex", model: "gpt-5.5" } },
      }),
    ).toThrow("Workflow upserts cannot change an actor's thread or model.");
  });
});

describe("investigation upsert roster rules", () => {
  const investigation = () => {
    const fixture = workflowArchiveFixture("investigation");
    const workflow = fixture.model.investigationWorkflows[0]!;
    const upsert = (next: typeof workflow) =>
      applyArchiveTestCommand(fixture.model, {
        type: "project.investigation-workflow.upsert",
        commandId: CommandId.makeUnsafe("investigation-upsert"),
        projectId: workflow.projectId,
        workflow: next,
        updatedAt: "2026-10-19T11:00:00.000Z",
      });
    return { workflow, upsert };
  };

  it("accepts an upsert that keeps the roster", () => {
    const { workflow, upsert } = investigation();
    expect(() => upsert({ ...workflow, title: "Renamed" })).not.toThrow();
  });

  it("rejects an upsert that changes an investigator's model", () => {
    const { workflow, upsert } = investigation();
    expect(() =>
      upsert({
        ...workflow,
        investigatorB: {
          ...workflow.investigatorB,
          slot: { provider: "codex", model: "gpt-5.5" },
        },
      }),
    ).toThrow("Workflow upserts cannot change an actor's thread or model.");
  });
});

describe("workflow creation provider rules", () => {
  const createCodeReview = (
    provider: "antigravity" | "muse" | "codex",
    providerInstances: ReadonlyArray<WorkflowProviderSnapshot> = [],
  ) => {
    const fixture = workflowArchiveFixture("codeReview");
    const projectId = fixture.model.projects[0]!.id;
    return Effect.runSync(
      decideOrchestrationCommand({
        readModel: { ...fixture.model, codeReviewWorkflows: [] },
        providerInstances,
        command: {
          type: "project.code-review-workflow.create",
          commandId: CommandId.makeUnsafe(`create-${provider}`),
          projectId,
          workflowId: CodeReviewWorkflowId.makeUnsafe(`review-${provider}`),
          title: "Review",
          slug: `review-${provider}`,
          // Version 2 runs reviewers as read-only turns (version 1 had no profile).
          templateId: "builtin.code-review.dual",
          templateVersion: 2,
          reviewPrompt: "Review the change",
          branch: null,
          reviewerA: { provider: "codex", model: "gpt-5-codex" },
          reviewerB: { provider, model: "some-model" },
          reviewerThreadIdA: ThreadId.makeUnsafe(`review-${provider}-a`),
          reviewerThreadIdB: ThreadId.makeUnsafe(`review-${provider}-b`),
          consolidation: { provider: "codex", model: "gpt-5-codex" },
          createdAt: "2026-10-19T11:00:00.000Z",
        },
      }),
    );
  };
  const antigravityInstance = (readOnlyWorkflowTurns: boolean) =>
    ({
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
      runtimeCapabilities: { readOnlyWorkflowTurns },
    }) as WorkflowProviderSnapshot;

  it("rejects Antigravity unless its instance reports certified read-only turns", () => {
    expect(() => createCodeReview("antigravity")).toThrow(
      "Antigravity cannot enforce read-only workflow turns.",
    );
    expect(() => createCodeReview("antigravity", [antigravityInstance(false)])).toThrow(
      "Antigravity cannot enforce read-only workflow turns.",
    );
    expect(() => createCodeReview("antigravity", [antigravityInstance(true)])).not.toThrow();
  });

  it("rejects Muse reviewers", () => {
    expect(() => createCodeReview("muse")).toThrow("cannot enforce read-only workflow turns.");
  });
});
