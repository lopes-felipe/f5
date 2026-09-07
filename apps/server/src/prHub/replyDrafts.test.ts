import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import Migration087 from "../persistence/Migrations/087_PrHubReplyDrafts.ts";
import { readReplyDraft, saveReplyDraft } from "./replyDrafts.ts";
import { PullRequestKey } from "@t3tools/contracts";

it.layer(SqliteClient.layerMemory())("reply drafts", (it) => {
  it.effect(
    "preserves text and comparison, rejects competing writers and isolates accounts and threads",
    () =>
      Effect.gen(function* () {
        yield* Migration087;
        const owner = {
          provider: "github",
          host: "github.com",
          viewerId: "1",
          repo: "org/repo",
          number: 1,
        };
        const input = {
          key: PullRequestKey.makeUnsafe("github:github.com/org/repo#1"),
          threadId: "thread",
          expectedVersion: 0,
          body: "Verbatim reply —\nkeep my text",
          comparisonVersion: "old-comparison",
        };
        const saved = yield* saveReplyDraft(owner, input);
        assert.equal(saved.status, "saved");
        assert.equal((yield* readReplyDraft(owner, "thread"))?.body, input.body);
        const conflict = yield* saveReplyDraft(owner, { ...input, body: "Overwrite" });
        assert.equal(conflict.status, "version_conflict");
        assert.equal(conflict.draft?.body, input.body);
        assert.equal((yield* readReplyDraft(owner, "thread"))?.comparisonVersion, "old-comparison");
        assert.equal(yield* readReplyDraft({ ...owner, viewerId: "2" }, "thread"), null);
        assert.equal(
          yield* readReplyDraft({ ...owner, host: "enterprise.example" }, "thread"),
          null,
        );
        assert.equal(yield* readReplyDraft(owner, "other-thread"), null);
      }),
  );
});
