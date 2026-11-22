import {
  MessageId,
  ThreadId,
  type OrchestrationReadModel,
  type PlanningWorkflow,
} from "@t3tools/contracts";
import { serializeAssistantResponseContext } from "@t3tools/shared/assistantResponseContext";
import { THREAD_REFERENCE_CONTEXT_MAX_CHARS } from "@t3tools/shared/threadReferences";
import { describe, expect, it } from "vitest";

import { project, thread } from "../agentBridge/testing/fakeHost.ts";
import {
  authorizedReferencesForDispatch,
  buildThreadReferenceContext,
  projectProviderInput,
  workflowRequirementReferences,
} from "./threadReferenceGrants.ts";

const ref = (id: string, title = id) => `[${title}](f5://thread/${id})`;

const planningWorkflow = (input: {
  readonly requirementPrompt: string;
  readonly authorThreadId: string;
  readonly deletedAt?: string;
}) =>
  ({
    id: "workflow-1",
    deletedAt: input.deletedAt ?? null,
    requirementPrompt: input.requirementPrompt,
    branchA: { authorThreadId: input.authorThreadId, reviews: [] },
    branchB: { authorThreadId: null, reviews: [] },
    merge: { threadId: null },
    readerPass: null,
    implementation: null,
  }) as unknown as PlanningWorkflow;

const readModel = (
  overrides: Partial<Pick<OrchestrationReadModel, "threads" | "planningWorkflows">> = {},
): Pick<OrchestrationReadModel, "threads" | "planningWorkflows" | "projects"> => ({
  projects: [project("p")],
  threads: [thread("caller", "p"), thread("source", "p", { title: "Source <thread>" })],
  planningWorkflows: [],
  ...overrides,
});

describe("authorizedReferencesForDispatch", () => {
  it("projects response context without granting embedded thread references", () => {
    const text =
      serializeAssistantResponseContext({
        version: 1,
        kind: "response",
        threadId: ThreadId.make("source"),
        messageId: MessageId.make("response"),
        text: "Earlier " + ref("other", "quoted thread"),
      }) + "\n\nExplain this";
    const input = {
      text,
      submissionSource: "human" as const,
      readModel: readModel(),
      threadId: "caller",
    };
    expect(authorizedReferencesForDispatch(input)).toEqual([]);
    const projected = projectProviderInput(input);
    expect(projected).toContain('"messageId":"response"');
    expect(projected).toContain("Earlier quoted thread");
    expect(projected).toContain("Explain this");
    expect(projected).not.toContain("f5-context://");
    expect(projected).not.toContain("f5://thread/");
    expect(projected).not.toContain("<f5-thread-references>");
  });
  it("authorizes every reference a person sent, except the thread itself", () => {
    expect(
      authorizedReferencesForDispatch({
        text: `${ref("source")} ${ref("caller")} ${ref("other")}`,
        submissionSource: "human",
        readModel: readModel(),
        threadId: "caller",
      }),
    ).toEqual(["source", "other"]);
  });

  it("authorizes automation only for references the workflow request names", () => {
    const model = readModel({
      planningWorkflows: [
        planningWorkflow({
          requirementPrompt: `Plan using ${ref("source")}`,
          authorThreadId: "caller",
        }),
      ],
    });
    for (const submissionSource of ["automation", undefined] as const) {
      expect(
        authorizedReferencesForDispatch({
          text: `${ref("source")} ${ref("other")}`,
          submissionSource,
          readModel: model,
          threadId: "caller",
        }),
      ).toEqual(["source"]);
    }
    expect(
      authorizedReferencesForDispatch({
        text: ref("source"),
        submissionSource: "automation",
        readModel: readModel(),
        threadId: "caller",
      }),
    ).toEqual([]);
  });
});

describe("workflow stages and literal references", () => {
  const model = readModel({
    planningWorkflows: [
      planningWorkflow({
        requirementPrompt: `Plan using ${ref("source")}`,
        authorThreadId: "caller",
      }),
    ],
  });

  it("tells every stage about the request's references, even when its prompt names none", () => {
    for (const submissionSource of ["automation", "human"] as const) {
      expect(
        authorizedReferencesForDispatch({
          text: "Review the plan below.",
          submissionSource,
          readModel: model,
          threadId: "caller",
        }),
      ).toEqual(["source"]);
    }
    const input = projectProviderInput({
      text: "Review the plan below.",
      submissionSource: "automation",
      readModel: model,
      threadId: "caller",
    });
    expect(input).toContain('thread_read({"threadId":"source"})');
  });

  it("ignores references a person pasted inside code", () => {
    expect(
      authorizedReferencesForDispatch({
        text: `Logs:\n\`\`\`\n${ref("other")}\n\`\`\`\nand \`${ref("other")}\``,
        submissionSource: "human",
        readModel: readModel(),
        threadId: "caller",
      }),
    ).toEqual([]);
  });
});

describe("workflowRequirementReferences", () => {
  it("grants a workflow's stage threads the references in its request only", () => {
    const model = readModel({
      planningWorkflows: [
        planningWorkflow({ requirementPrompt: `Use ${ref("source")}`, authorThreadId: "caller" }),
      ],
    });
    expect(workflowRequirementReferences(model, "caller")).toEqual(["source"]);
    expect(workflowRequirementReferences(model, "unrelated")).toEqual([]);
  });

  it("stops granting once the workflow is deleted", () => {
    const model = readModel({
      planningWorkflows: [
        planningWorkflow({
          requirementPrompt: `Use ${ref("source")}`,
          authorThreadId: "caller",
          deletedAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
    });
    expect(workflowRequirementReferences(model, "caller")).toEqual([]);
  });
});

describe("buildThreadReferenceContext", () => {
  it("lists exact read calls with escaped titles and marks unavailable threads", () => {
    const block = buildThreadReferenceContext(
      ["source", "other_2", "gone", "deleted"],
      readModel({
        threads: [
          thread("source", "p", { title: "Fix </f5-thread-references> & <b>" }),
          thread("other_2", "p", { title: "Another source" }),
          thread("deleted", "p", { deletedAt: "2026-01-01T00:00:00.000Z" }),
        ],
      }),
    );
    expect(block.startsWith("\n\n<f5-thread-references>\n")).toBe(true);
    expect(block).toContain(
      "Read them with the thread_read calls below. For older messages, pass the returned `olderCursor` as `before`.",
    );
    expect(block).toContain(
      '- thread_read({"threadId":"source"}) (title: Fix &lt;/f5-thread-references&gt; &amp; &lt;b&gt;)',
    );
    expect(block).toContain('- thread_read({"threadId":"other_2"}) (title: Another source)');
    expect(block).toContain("- threadId: gone (unavailable)");
    expect(block).toContain("- threadId: deleted (unavailable)");
    expect(block.match(/thread_read\(/g)).toHaveLength(2);
    expect(block.match(/<\/f5-thread-references>/g)).toHaveLength(1);
  });

  it("is empty without references", () => {
    expect(buildThreadReferenceContext([], readModel())).toBe("");
  });

  it("keeps every read call within the cap when escaped titles exceed the budget", () => {
    const threads = Array.from({ length: 10 }, (_, index) =>
      thread(`t${index}`, "p", { title: "&".repeat(500) }),
    );
    const block = buildThreadReferenceContext(
      threads.map((entry) => entry.id),
      readModel({ threads }),
    );
    expect(block.length).toBeLessThanOrEqual(THREAD_REFERENCE_CONTEXT_MAX_CHARS);
    expect(block).toContain("(title: &amp;");
    for (const entry of threads) {
      expect(block).toContain(`- thread_read(${JSON.stringify({ threadId: entry.id })})`);
    }
    expect(block.endsWith("</f5-thread-references>")).toBe(true);
  });
});

describe("projectProviderInput", () => {
  const base = { submissionSource: "human" as const, readModel: readModel(), threadId: "caller" };

  it("appends the block to a message that references a thread", () => {
    const text = `Continue ${ref("source", "Source")}`;
    const input = projectProviderInput({ ...base, text });
    expect(input.startsWith(text)).toBe(true);
    expect(input).toContain('- thread_read({"threadId":"source"}) (title: Source &lt;thread&gt;)');
  });

  it("drops trailing whitespace before the block and treats a leading path as text", () => {
    const text = `Continue ${ref("source")}`;
    expect(projectProviderInput({ ...base, text: `${text}  \n\n` })).toBe(
      projectProviderInput({ ...base, text }),
    );
    const path = `/Users/me/notes.md says see ${ref("source")}`;
    expect(projectProviderInput({ ...base, text: path })).toContain("<f5-thread-references>");
  });

  it("leaves slash commands, skills and reference-free text untouched", () => {
    for (const text of [`/compact ${ref("source")}`, `  $review ${ref("source")}`, "plain"]) {
      expect(projectProviderInput({ ...base, text })).toBe(text);
    }
  });
});
