import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AcpToolCallState } from "./AcpRuntimeModel.ts";
import {
  ANTIGRAVITY_PLAN_READ_LIMIT_BYTES,
  AntigravityPlanArtifactTracker,
  antigravityArtifactRequestsFeedback,
  antigravityArtifactWrite,
  antigravityBrainRoots,
  readAntigravityPlanArtifact,
  truncateUtf8,
} from "./AntigravityPlanArtifacts.ts";

let profile: string;
let brain: string;

beforeEach(async () => {
  profile = await mkdtemp(path.join(os.tmpdir(), "agy-plan-artifacts-"));
  brain = path.join(profile, "antigravity-acp", "brain");
});
afterEach(async () => {
  await rm(profile, { recursive: true, force: true });
});

const write = (
  filePath: string,
  rawInput: Record<string, unknown> = {},
  status: AcpToolCallState["status"] = "completed",
  toolCallId = "call-1",
): AcpToolCallState => ({
  toolCallId,
  kind: "edit",
  title: "File plan.md",
  status,
  data: {
    toolCallId: "call-1",
    rawInput: {
      Path: filePath,
      ArtifactMetadata: { RequestFeedback: true },
      Content: "# Plan",
      ...rawInput,
    },
  },
});

describe("antigravityArtifactRequestsFeedback", () => {
  it("reads the object and the Python-style string forms", () => {
    expect(antigravityArtifactRequestsFeedback({ RequestFeedback: true })).toBe(true);
    expect(antigravityArtifactRequestsFeedback({ RequestFeedback: false })).toBe(false);
    expect(antigravityArtifactRequestsFeedback("{'RequestFeedback': True, 'Summary': 'x'}")).toBe(
      true,
    );
    expect(antigravityArtifactRequestsFeedback('{"RequestFeedback": true}')).toBe(true);
    expect(antigravityArtifactRequestsFeedback("{'RequestFeedback': False}")).toBe(false);
    expect(antigravityArtifactRequestsFeedback(undefined)).toBe(false);
  });
});

describe("antigravityArtifactWrite", () => {
  it("recognizes writes into a conversation's brain directory only", () => {
    const roots = antigravityBrainRoots(profile);
    const inside = antigravityArtifactWrite(write(path.join(brain, "conv-1", "plan.md")), roots);
    expect(inside).toMatchObject({
      basename: "plan.md",
      conversationId: "conv-1",
      requestsFeedback: true,
      content: "# Plan",
    });
    expect(antigravityArtifactWrite(write(path.join(profile, "plan.md")), roots)).toBeUndefined();
    expect(antigravityArtifactWrite(write(path.join(brain, "plan.md")), roots)).toBeUndefined();
    expect(
      antigravityArtifactWrite(write(path.join(brain, "conv-1", "..", "..", "x.md")), roots),
    ).toBeUndefined();
    expect(antigravityArtifactWrite(write("relative/plan.md"), roots)).toBeUndefined();
    expect(antigravityArtifactWrite(write(path.join(brain, "c", "p.md")), [])).toBeUndefined();
  });

  it("ignores reads and searches of brain files", () => {
    const roots = antigravityBrainRoots(profile);
    const target = path.join(brain, "conv-1", "task.md");
    const read = (
      kind: NonNullable<AcpToolCallState["kind"]>,
      title: string,
    ): AcpToolCallState => ({
      toolCallId: "read-1",
      kind,
      title,
      status: "completed",
      data: { toolCallId: "read-1", rawInput: { Path: target }, locations: [{ path: target }] },
    });
    expect(antigravityArtifactWrite(read("read", "view_file"), roots)).toBeUndefined();
    expect(antigravityArtifactWrite(read("search", "grep_search"), roots)).toBeUndefined();
    expect(antigravityArtifactWrite(read("other", "Running view_file"), roots)).toBeUndefined();
    // Native writes start as `other`; the title or the artifact metadata marks them.
    expect(antigravityArtifactWrite(read("other", "Running write_to_file"), roots)).toBeDefined();
    expect(
      antigravityArtifactWrite({ ...write(target), kind: "other", title: "File task.md" }, roots),
    ).toBeDefined();
  });

  it("falls back to the reported location", () => {
    const target = path.join(brain, "conv-1", "task.md");
    const tool: AcpToolCallState = {
      toolCallId: "call-2",
      kind: "edit",
      status: "completed",
      data: { toolCallId: "call-2", locations: [{ path: target }] },
    };
    expect(antigravityArtifactWrite(tool, antigravityBrainRoots(profile))).toMatchObject({
      basename: "task.md",
      requestsFeedback: false,
    });
  });
});

describe("AntigravityPlanArtifactTracker", () => {
  it("keeps the newest feedback artifact of the session's own conversation", () => {
    const tracker = new AntigravityPlanArtifactTracker(antigravityBrainRoots(profile));
    const plan = path.join(brain, "conv-1", "plan.md");
    tracker.observe(write(path.join(brain, "other", "plan.md")), "conv-1");
    tracker.observe(
      write(path.join(brain, "conv-1", "task.md"), { ArtifactMetadata: {} }),
      "conv-1",
    );
    tracker.observe(write(plan, { Content: "# Full plan" }, "inProgress"), "conv-1");
    // A later update without the content keeps the content an earlier one carried.
    tracker.observe(write(plan, { Content: undefined }), "conv-1");
    tracker.observe(write(path.join(brain, "conv-1", "failed.md"), {}, "failed"), "conv-1");
    expect(tracker.take()).toMatchObject({ path: plan, content: "# Full plan" });
    expect(tracker.take()).toBeUndefined();
    tracker.observe(write(plan), "conv-1");
    tracker.reset();
    expect(tracker.take()).toBeUndefined();
  });

  it("counts a write only once its call completes", () => {
    const tracker = new AntigravityPlanArtifactTracker(antigravityBrainRoots(profile));
    const plan = path.join(brain, "conv-1", "plan.md");
    tracker.observe(write(plan, { Content: "# First" }, "completed", "first"), "conv-1");
    // A rewrite that fails never replaces the plan that was written.
    tracker.observe(write(plan, { Content: "# Rewrite" }, "inProgress", "second"), "conv-1");
    tracker.observe(
      { toolCallId: "second", kind: "edit", status: "failed", data: { toolCallId: "second" } },
      "conv-1",
    );
    expect(tracker.take()).toMatchObject({ content: "# First" });

    // A write still running when the turn ends is not the plan either.
    tracker.observe(write(plan, {}, "inProgress", "third"), "conv-1");
    expect(tracker.take()).toBeUndefined();

    // A completion update without the input completes the write an earlier update named.
    tracker.observe(write(plan, { Content: "# Later" }, "pending", "fourth"), "conv-1");
    tracker.observe(
      { toolCallId: "fourth", kind: "edit", status: "completed", data: { toolCallId: "fourth" } },
      "conv-1",
    );
    expect(tracker.take()).toMatchObject({ path: plan, content: "# Later" });
  });
});

describe("readAntigravityPlanArtifact", () => {
  it("reads the file, and falls back to the captured content", async () => {
    const plan = path.join(brain, "conv-1", "plan.md");
    await mkdir(path.dirname(plan), { recursive: true });
    await writeFile(plan, "# On disk\n");
    const roots = antigravityBrainRoots(profile);
    const found = antigravityArtifactWrite(write(plan, { Content: "# Captured" }), roots)!;
    expect(await readAntigravityPlanArtifact(found, roots)).toBe("# On disk\n");

    await writeFile(plan, "x".repeat(ANTIGRAVITY_PLAN_READ_LIMIT_BYTES + 1));
    expect(await readAntigravityPlanArtifact(found, roots)).toBe("# Captured");

    await rm(plan);
    await symlink(path.join(profile, "secret"), plan);
    expect(await readAntigravityPlanArtifact(found, roots)).toBe("# Captured");

    const missing = antigravityArtifactWrite(
      write(path.join(brain, "conv-1", "gone.md"), { Content: undefined }),
      roots,
    )!;
    expect(await readAntigravityPlanArtifact(missing, roots)).toBeUndefined();
  });

  it("refuses a conversation directory that links outside the brain root", async () => {
    const outside = path.join(profile, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "plan.md"), "# Outside\n");
    await mkdir(brain, { recursive: true });
    await symlink(
      outside,
      path.join(brain, "conv-1"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const roots = antigravityBrainRoots(profile);
    const found = antigravityArtifactWrite(
      write(path.join(brain, "conv-1", "plan.md"), { Content: "# Captured" }),
      roots,
    )!;
    expect(await readAntigravityPlanArtifact(found, roots)).toBe("# Captured");
  });

  it("bounds the captured fallback in UTF-8 bytes", async () => {
    const roots = antigravityBrainRoots(profile);
    const wide = "\u754c".repeat(ANTIGRAVITY_PLAN_READ_LIMIT_BYTES);
    const found = antigravityArtifactWrite(
      write(path.join(brain, "conv-1", "gone.md"), { Content: wide }),
      roots,
    )!;
    const text = (await readAntigravityPlanArtifact(found, roots))!;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(ANTIGRAVITY_PLAN_READ_LIMIT_BYTES);
    expect(text).toBe("\u754c".repeat(Math.floor(ANTIGRAVITY_PLAN_READ_LIMIT_BYTES / 3)));
    expect(truncateUtf8("short", 3)).toBe("sho");
    expect(truncateUtf8("a\u754c", 3)).toBe("a");
    expect(truncateUtf8("kept", 10)).toBe("kept");
  });
});
