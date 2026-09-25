import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { makeClaudeTextGeneration } from "../src/git/Layers/ClaudeTextGeneration.ts";

// Real pinned CLI, synthetic local API: no account or external inference required.
it("keeps structured output working with tools disabled and never runs user hooks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "f5-claude-metadata-gate-"));
  const configDirectory = join(directory, "config");
  const hookMarker = join(directory, "hook-ran");
  const hookScript = join(directory, "hook.cjs");
  const requests: Array<{ tools?: Array<{ name: string }>; stream?: boolean }> = [];
  const errors: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (!request.url?.startsWith("/v1/messages")) {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const input = JSON.parse(body);
      requests.push(input);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (event: string, data: unknown) =>
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", {
        type: "message_start",
        message: {
          id: "msg_metadata_gate",
          type: "message",
          role: "assistant",
          model: input.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      });
      send("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_metadata_gate",
          name: "StructuredOutput",
          input: {},
        },
      });
      send("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ title: "Safety gate" }) },
      });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 10 },
      });
      send("message_stop", { type: "message_stop" });
      response.end();
    } catch (error) {
      errors.push(error);
      response.writeHead(500).end();
    }
  });
  try {
    await mkdir(configDirectory);
    await writeFile(
      hookScript,
      `require("node:fs").writeFileSync(${JSON.stringify(hookMarker)}, "hook ran");`,
    );
    await writeFile(
      join(configDirectory, "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: `"${process.execPath}" "${hookScript}"` }] },
          ],
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    // Do not inherit credentials, proxy settings, API-key helpers or account config.
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      PATHEXT: process.env.PATHEXT,
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      CLAUDE_CONFIG_DIR: configDirectory,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: configDirectory,
      ANTHROPIC_API_KEY: "synthetic-metadata-gate-key",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const generation = yield* makeClaudeTextGeneration(
          Schema.decodeSync(ClaudeSettings)({}),
          environment,
        );
        return yield* generation.generateThreadTitle({
          cwd: directory,
          message: "Return the title Safety gate.",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-haiku-4-5",
          },
        });
      }).pipe(Effect.provide(NodeServices.layer), Effect.timeout("20 seconds")),
    );
    expect(result).toEqual({ title: "Safety gate" });
    expect(errors).toEqual([]);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.stream).toBe(true);
      expect(request.tools?.map((tool) => tool.name)).toEqual(["StructuredOutput"]);
    }
    await expect(access(hookMarker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);
