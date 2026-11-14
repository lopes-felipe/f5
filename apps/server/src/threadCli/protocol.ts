import { z } from "zod";

// Leaves room for JSON escaping inside the transport's 1 MiB request cap.
export const MAX_MESSAGE_BYTES = 128 * 1024;

export const projectSchema = z.object({
  id: z.string(),
  title: z.string(),
  workspaceRoot: z.string(),
});
export const messageSchema = z.object({
  role: z.string(),
  text: z.string(),
  turnId: z.string().nullable(),
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
});
export const waitSchema = submittedSchema.extend({
  status: z.string(),
  timedOut: z.boolean(),
  reply: z.string().nullable(),
  reason: z.string().optional(),
});
export const readSchema = z.object({
  thread: threadSchema,
  messages: z.array(messageSchema),
});
export const sessionSchema = z.object({ token: z.string() });
export const projectsSchema = z.object({ projects: z.array(projectSchema) });
export const threadsSchema = z.object({ threads: z.array(threadSchema) });

export const ownerCredentialsPath = (stateDir: string) => stateDir + "/thread-cli/local.json";
