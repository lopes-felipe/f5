/**
 * Repository-scoped MCP servers: a read-only layer from `<project root>/.mcp.json`.
 *
 * A repository server runs only once the user approves its exact definition for the
 * project. Approvals are keyed by project, server name and a hash of the definition,
 * so a changed definition is listed as "Changed" and never started until approved
 * again. The file is read from the project root only (not each thread's worktree),
 * so there is one trust decision per project.
 */
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";

import type { McpProjectServersConfig, ProjectId } from "@t3tools/contracts";
import { mergeMcpServerLayers, stableMcpServersJson } from "@t3tools/shared/mcpConfig";
import { parseMcpImport } from "@t3tools/shared/mcpImport";
import {
  MCP_EFFECTIVE_SERVER_LIMIT,
  MCP_SERVERS_PER_SCOPE,
  mcpServerNameKey,
} from "@t3tools/shared/mcpValidation";
import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { readMcpImportFile } from "./McpImportDetection.ts";

export const MCP_REPOSITORY_FILE = ".mcp.json";

/**
 * Why approving `serverName` must be refused, or `undefined`: approving counts toward
 * the project's effective server limit, like any other layer.
 */
export function repositoryApprovalLimitIssue(input: {
  readonly layer: McpRepositoryLayer;
  readonly serverName: string;
  readonly common: McpProjectServersConfig;
  readonly project: McpProjectServersConfig;
  readonly disabledCommon?: ReadonlyArray<string> | undefined;
}): string | undefined {
  const key = mcpServerNameKey(input.serverName);
  const entry = input.layer.entries.find((candidate) => mcpServerNameKey(candidate.name) === key);
  if (!entry || entry.approved) return undefined;
  const merged = mergeMcpServerLayers({
    common: input.common,
    repository: { ...input.layer.approved, [entry.name]: entry.server },
    project: input.project,
    disabledCommon: input.disabledCommon,
  });
  return Object.keys(merged).length > MCP_EFFECTIVE_SERVER_LIMIT
    ? `Approving '${entry.name}' would exceed the ${MCP_EFFECTIVE_SERVER_LIMIT}-server limit for this project. Remove or turn off another server first.`
    : undefined;
}

export interface McpRepositoryEntry {
  readonly name: string;
  readonly server: McpProjectServersConfig[string];
  readonly definitionHash: string;
  readonly approved: boolean;
  /** Approved before, but the definition has changed since. */
  readonly changed: boolean;
}

export interface McpRepositoryLayer {
  readonly path?: string | undefined;
  readonly found: boolean;
  readonly entries: ReadonlyArray<McpRepositoryEntry>;
  readonly issues: ReadonlyArray<string>;
  /** Only the approved servers, as a configuration layer. */
  readonly approved: McpProjectServersConfig;
  /** Changes whenever the approved layer does; empty when nothing is approved. */
  readonly version: string;
  /**
   * Name keys F5 must no longer run from this repository: servers in the file that are
   * not approved (revoked, never approved or changed), and approved names the file no
   * longer lists. Live sessions still using one are cut off.
   */
  readonly withdrawn: ReadonlyArray<string>;
}

export class McpRepositoryTrustError extends Schema.TaggedErrorClass<McpRepositoryTrustError>()(
  "McpRepositoryTrustError",
  { message: Schema.String },
) {}

export interface McpRepositoryServersShape {
  /** Never fails: an unreadable or invalid file is reported in `issues`. */
  readonly readLayer: (projectId: ProjectId) => Effect.Effect<McpRepositoryLayer>;
  /** Projects with at least one approval, whether or not the file still lists it. */
  readonly trustedProjects: () => ReadonlyArray<ProjectId>;
  readonly setTrust: (input: {
    readonly projectId: ProjectId;
    readonly serverName: string;
    readonly trusted: boolean;
    readonly definitionHash?: string | undefined;
  }) => Effect.Effect<McpRepositoryLayer, McpRepositoryTrustError>;
}

export class McpRepositoryServers extends ServiceMap.Service<
  McpRepositoryServers,
  McpRepositoryServersShape
>()("t3/mcp/McpRepositoryServers") {}

export function repositoryDefinitionHash(
  name: string,
  server: McpProjectServersConfig[string],
): string {
  return createHash("sha256")
    .update(stableMcpServersJson({ [name]: server }))
    .digest("hex")
    .slice(0, 32);
}

const EMPTY_LAYER: McpRepositoryLayer = {
  found: false,
  entries: [],
  issues: [],
  approved: {},
  version: "",
  withdrawn: [],
};

interface ParsedFile {
  readonly stamp: string;
  readonly servers: ReadonlyArray<{
    readonly name: string;
    readonly server: McpProjectServersConfig[string];
  }>;
  readonly issues: ReadonlyArray<string>;
}

/** Reads and parses `.mcp.json`; `undefined` when the file does not exist. */
async function readRepositoryFile(
  filename: string,
  cached: ParsedFile | undefined,
): Promise<ParsedFile | undefined> {
  let stat;
  try {
    stat = await lstat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // A symlink could point the repository at files outside it.
  if (stat.isSymbolicLink())
    throw new Error(`${MCP_REPOSITORY_FILE} is a symbolic link; F5 only reads a regular file.`);
  const stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  if (cached?.stamp === stamp) return cached;
  const text = await readMcpImportFile(filename);
  if (text === null) return undefined;
  const parsed = parseMcpImport(text, filename);
  const issues = parsed.issues.map((issue) => issue.message);
  const servers: Array<{ name: string; server: McpProjectServersConfig[string] }> = [];
  for (const candidate of parsed.candidates) {
    const errors = candidate.issues.filter((issue) => issue.severity === "error");
    if (!candidate.server || errors.length > 0) {
      issues.push(
        `${candidate.name}: ${errors.map((issue) => issue.message).join(" ") || "Left out because it is invalid."}`,
      );
      continue;
    }
    if (servers.length === MCP_SERVERS_PER_SCOPE) {
      issues.push(
        `${candidate.name}: Left out; a repository can list at most ${MCP_SERVERS_PER_SCOPE} servers.`,
      );
      continue;
    }
    servers.push({ name: candidate.name, server: candidate.server });
  }
  return { stamp, servers, issues };
}

export const makeMcpRepositoryServers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectionProjectRepository;
  const trust = new Map<string, Map<string, string>>();
  const files = new Map<string, ParsedFile>();

  const rows = yield* sql<{
    projectId: string;
    serverName: string;
    definitionHash: string;
  }>`SELECT project_id AS "projectId", server_name AS "serverName", definition_hash AS "definitionHash" FROM mcp_repository_trust`.pipe(
    // Unreadable approvals fail closed: nothing from a repository runs until approved again.
    Effect.tapError((error) =>
      Effect.logWarning("MCP repository approvals could not be read", { error: String(error) }),
    ),
    Effect.orElseSucceed(() => []),
  );
  for (const row of rows) {
    const byName = trust.get(row.projectId) ?? new Map<string, string>();
    byName.set(mcpServerNameKey(row.serverName), row.definitionHash);
    trust.set(row.projectId, byName);
  }

  const projectRoot = (projectId: ProjectId) =>
    projects.getById({ projectId }).pipe(
      Effect.map((row) =>
        Option.match(row, {
          onNone: () => undefined,
          onSome: (project) => (project.deletedAt ? undefined : project.workspaceRoot),
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );

  const readLayer = (projectId: ProjectId): Effect.Effect<McpRepositoryLayer> =>
    Effect.gen(function* () {
      const trustedKeys = [...(trust.get(projectId)?.keys() ?? [])];
      const root = yield* projectRoot(projectId);
      if (!root) return { ...EMPTY_LAYER, withdrawn: trustedKeys };
      const filename = path.join(root, MCP_REPOSITORY_FILE);
      const read = yield* Effect.tryPromise({
        try: () => readRepositoryFile(filename, files.get(projectId)),
        catch: (error) =>
          new McpRepositoryTrustError({
            message: error instanceof Error ? error.message : String(error),
          }),
      }).pipe(
        Effect.map((parsed) => ({ parsed, error: undefined as string | undefined })),
        Effect.catch((error) =>
          Effect.succeed({
            parsed: undefined,
            error: `${MCP_REPOSITORY_FILE} could not be read: ${error.message}`,
          }),
        ),
      );
      if (read.parsed) files.set(projectId, read.parsed);
      else files.delete(projectId);
      if (!read.parsed)
        return {
          ...EMPTY_LAYER,
          path: filename,
          found: read.error !== undefined,
          issues: read.error ? [read.error] : [],
          withdrawn: trustedKeys,
        };
      const approvedHashes = trust.get(projectId);
      const approved: Record<string, McpProjectServersConfig[string]> = {};
      const entries = read.parsed.servers.map(({ name, server }) => {
        const definitionHash = repositoryDefinitionHash(name, server);
        const stored = approvedHashes?.get(mcpServerNameKey(name));
        const isApproved = stored === definitionHash;
        if (isApproved) approved[name] = server;
        return {
          name,
          server,
          definitionHash,
          approved: isApproved,
          changed: stored !== undefined && !isApproved,
        };
      });
      const approvedNames = Object.keys(approved);
      const listed = new Set(entries.map((entry) => mcpServerNameKey(entry.name)));
      const withdrawn = [
        ...entries.filter((entry) => !entry.approved).map((entry) => mcpServerNameKey(entry.name)),
        ...trustedKeys.filter((key) => !listed.has(key)),
      ];
      return {
        path: filename,
        found: true,
        entries,
        issues: read.parsed.issues,
        approved,
        version: approvedNames.length
          ? createHash("sha256").update(stableMcpServersJson(approved)).digest("hex").slice(0, 16)
          : "",
        withdrawn,
      };
    });

  const setTrust: McpRepositoryServersShape["setTrust"] = (input) =>
    Effect.gen(function* () {
      const key = mcpServerNameKey(input.serverName);
      if (!input.trusted) {
        yield* sql`DELETE FROM mcp_repository_trust WHERE project_id=${input.projectId} AND server_name=${key}`.pipe(
          Effect.mapError(
            () => new McpRepositoryTrustError({ message: "The approval could not be removed." }),
          ),
        );
        trust.get(input.projectId)?.delete(key);
        return yield* readLayer(input.projectId);
      }
      const layer = yield* readLayer(input.projectId);
      const entry = layer.entries.find((candidate) => mcpServerNameKey(candidate.name) === key);
      if (!entry)
        return yield* new McpRepositoryTrustError({
          message: `'${input.serverName}' is no longer in ${MCP_REPOSITORY_FILE}.`,
        });
      if (input.definitionHash !== entry.definitionHash)
        return yield* new McpRepositoryTrustError({
          message: `'${input.serverName}' changed in ${MCP_REPOSITORY_FILE} since you reviewed it. Review it again.`,
        });
      const approvedAt = new Date().toISOString();
      yield* sql`INSERT INTO mcp_repository_trust (project_id, server_name, definition_hash, approved_at)
        VALUES (${input.projectId}, ${key}, ${entry.definitionHash}, ${approvedAt})
        ON CONFLICT(project_id, server_name) DO UPDATE SET definition_hash=excluded.definition_hash, approved_at=excluded.approved_at`.pipe(
        Effect.mapError(
          () => new McpRepositoryTrustError({ message: "The approval could not be saved." }),
        ),
      );
      const byName = trust.get(input.projectId) ?? new Map<string, string>();
      byName.set(key, entry.definitionHash);
      trust.set(input.projectId, byName);
      return yield* readLayer(input.projectId);
    });

  const trustedProjects = () =>
    [...trust.entries()]
      .filter(([, byName]) => byName.size > 0)
      .map(([projectId]) => projectId as ProjectId);

  return { readLayer, trustedProjects, setTrust } satisfies McpRepositoryServersShape;
});

export const McpRepositoryServersLive = Layer.effect(
  McpRepositoryServers,
  makeMcpRepositoryServers,
);
