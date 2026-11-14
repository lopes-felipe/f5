import { z } from "zod";
import * as Path from "node:path";

// Leaves room for JSON escaping inside the transport's 1 MiB request cap.
export const MAX_MESSAGE_BYTES = 128 * 1024;
export const READ_PAGE_MESSAGES = 20;
export const READ_TEXT_CHARS = 4096;

export const projectSchema = z.object({
  id: z.string(),
  title: z.string(),
  workspaceRoot: z.string(),
});
export const messageSchema = z.object({
  id: z.string(),
  role: z.string(),
  text: z.string(),
  turnId: z.string().nullable(),
  nextTextOffset: z.number().nullable(),
});
export const threadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.string(),
  model: z.string(),
  provider: z.string().nullable(),
  runtimeMode: z.string(),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  pendingRequestCount: z.number().int(),
});
export const submittedSchema = z.object({
  threadId: z.string(),
  submissionId: z.string(),
  delivery: z.enum(["started", "queued"]).optional(),
});
export const waitSchema = submittedSchema.extend({
  status: z.string(),
  timedOut: z.boolean(),
  reply: z.string().nullable(),
  reason: z.string().optional(),
  replyMessageId: z.string().optional(),
  nextTextOffset: z.number().nullable().optional(),
});
export const readSchema = z.object({
  thread: threadSchema,
  messages: z.array(messageSchema),
  nextCursor: z.number().nullable(),
  anchorId: z.string().nullable(),
});
export const sessionSchema = z.object({ token: z.string() });
export const projectsSchema = z.object({ projects: z.array(projectSchema) });
export const threadsSchema = z.object({ threads: z.array(threadSchema) });

export const ownerCredentialsPath = (stateDir: string) =>
  Path.join(stateDir, "thread-cli", "local.json");
