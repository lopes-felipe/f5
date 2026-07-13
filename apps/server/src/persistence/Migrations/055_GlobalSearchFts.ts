import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS search_documents (
      document_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      workflow_id TEXT,
      message_id TEXT,
      turn_id TEXT,
      file_change_id TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      role TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_search_documents_scope
    ON search_documents(project_id, thread_id, created_at DESC)
  `;

  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS search_documents_fts USING fts5(
      title,
      content,
      path,
      content='search_documents',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    )
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS search_documents_after_insert
    AFTER INSERT ON search_documents BEGIN
      INSERT INTO search_documents_fts(rowid, title, content, path)
      VALUES (new.rowid, new.title, new.content, new.path);
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS search_documents_after_delete
    AFTER DELETE ON search_documents BEGIN
      INSERT INTO search_documents_fts(search_documents_fts, rowid, title, content, path)
      VALUES ('delete', old.rowid, old.title, old.content, old.path);
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS search_documents_after_update
    AFTER UPDATE ON search_documents BEGIN
      INSERT INTO search_documents_fts(search_documents_fts, rowid, title, content, path)
      VALUES ('delete', old.rowid, old.title, old.content, old.path);
      INSERT INTO search_documents_fts(rowid, title, content, path)
      VALUES (new.rowid, new.title, new.content, new.path);
    END
  `;

  const sourceTrigger = (name: string, source: string, body: string) =>
    sql.unsafe(`
      CREATE TRIGGER IF NOT EXISTS ${name}
      AFTER INSERT ON ${source} BEGIN ${body} END
    `);
  const sourceUpdateTrigger = (name: string, source: string, body: string) =>
    sql.unsafe(`
      CREATE TRIGGER IF NOT EXISTS ${name}
      AFTER UPDATE ON ${source} BEGIN ${body} END
    `);
  const sourceDeleteTrigger = (name: string, source: string, keyExpression: string) =>
    sql.unsafe(`
      CREATE TRIGGER IF NOT EXISTS ${name}
      AFTER DELETE ON ${source} BEGIN
        DELETE FROM search_documents WHERE document_key = ${keyExpression};
      END
    `);

  const threadBody = `
    DELETE FROM search_documents WHERE document_key = 'thread:' || new.thread_id;
    INSERT INTO search_documents (
      document_key, kind, entity_id, project_id, thread_id, title, content, created_at
    )
    SELECT
      'thread:' || new.thread_id, 'thread', new.thread_id, new.project_id, new.thread_id,
      new.title, trim(new.title || ' ' || coalesce(new.branch, '')), new.last_interaction_at
    WHERE new.deleted_at IS NULL;
  `;
  yield* sourceTrigger("search_projection_threads_insert", "projection_threads", threadBody);
  yield* sourceUpdateTrigger("search_projection_threads_update", "projection_threads", threadBody);
  yield* sourceDeleteTrigger(
    "search_projection_threads_delete",
    "projection_threads",
    "'thread:' || old.thread_id",
  );

  const messageBody = `
    DELETE FROM search_documents WHERE document_key = 'message:' || new.message_id;
    INSERT INTO search_documents (
      document_key, kind, entity_id, project_id, thread_id, message_id, turn_id,
      title, content, role, created_at
    )
    SELECT
      'message:' || new.message_id, 'message', new.message_id, thread.project_id,
      new.thread_id, new.message_id, new.turn_id, thread.title, new.text, new.role, new.created_at
    FROM projection_threads AS thread
    WHERE thread.thread_id = new.thread_id
      AND thread.deleted_at IS NULL
      AND new.role IN ('user', 'assistant')
      AND length(trim(new.text)) > 0;
  `;
  yield* sourceTrigger(
    "search_projection_thread_messages_insert",
    "projection_thread_messages",
    messageBody,
  );
  yield* sourceUpdateTrigger(
    "search_projection_thread_messages_update",
    "projection_thread_messages",
    messageBody,
  );
  yield* sourceDeleteTrigger(
    "search_projection_thread_messages_delete",
    "projection_thread_messages",
    "'message:' || old.message_id",
  );

  const activityBody = `
    DELETE FROM search_documents WHERE document_key = 'activity:' || new.activity_id;
    INSERT INTO search_documents (
      document_key, kind, entity_id, project_id, thread_id, turn_id,
      title, content, created_at
    )
    SELECT
      'activity:' || new.activity_id, 'activity', new.activity_id, thread.project_id,
      new.thread_id, new.turn_id, new.summary, new.summary, new.created_at
    FROM projection_threads AS thread
    WHERE thread.thread_id = new.thread_id
      AND thread.deleted_at IS NULL
      AND length(trim(new.summary)) > 0;
  `;
  yield* sourceTrigger(
    "search_projection_thread_activities_insert",
    "projection_thread_activities",
    activityBody,
  );
  yield* sourceUpdateTrigger(
    "search_projection_thread_activities_update",
    "projection_thread_activities",
    activityBody,
  );
  yield* sourceDeleteTrigger(
    "search_projection_thread_activities_delete",
    "projection_thread_activities",
    "'activity:' || old.activity_id",
  );

  const fileChangeBody = `
    DELETE FROM search_documents WHERE document_key = 'file-change:' || new.file_change_id;
    INSERT INTO search_documents (
      document_key, kind, entity_id, project_id, thread_id, turn_id, file_change_id,
      title, content, path, created_at
    )
    SELECT
      'file-change:' || new.file_change_id, 'fileChange', new.file_change_id,
      thread.project_id, new.thread_id, new.turn_id, new.file_change_id,
      coalesce(new.title, 'Changed files'), coalesce(new.detail, ''), new.changed_files,
      new.started_at
    FROM projection_threads AS thread
    WHERE thread.thread_id = new.thread_id AND thread.deleted_at IS NULL;
  `;
  yield* sourceTrigger(
    "search_projection_thread_file_changes_insert",
    "projection_thread_file_changes",
    fileChangeBody,
  );
  yield* sourceUpdateTrigger(
    "search_projection_thread_file_changes_update",
    "projection_thread_file_changes",
    fileChangeBody,
  );
  yield* sourceDeleteTrigger(
    "search_projection_thread_file_changes_delete",
    "projection_thread_file_changes",
    "'file-change:' || old.file_change_id",
  );

  const workflowSources = [
    {
      source: "projection_planning_workflows",
      prefix: "planning",
      promptPath: "$.requirementPrompt",
    },
    {
      source: "projection_code_review_workflows",
      prefix: "codeReview",
      promptPath: "$.reviewPrompt",
    },
    {
      source: "projection_investigation_workflows",
      prefix: "investigation",
      promptPath: "$.problemPrompt",
    },
  ] as const;
  const workflowSourceRows = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN (
        'projection_planning_workflows',
        'projection_code_review_workflows',
        'projection_investigation_workflows'
      )
  `;
  const existingWorkflowSources = new Set(workflowSourceRows.map((row) => row.name));
  for (const workflow of workflowSources) {
    if (!existingWorkflowSources.has(workflow.source)) continue;
    const body = `
      DELETE FROM search_documents
      WHERE document_key = 'workflow.${workflow.prefix}:' || new.workflow_id;
      INSERT INTO search_documents (
        document_key, kind, entity_id, project_id, workflow_id, title, content, created_at
      )
      SELECT
        'workflow.${workflow.prefix}:' || new.workflow_id,
        'workflow.${workflow.prefix}', new.workflow_id, new.project_id, new.workflow_id,
        coalesce(json_extract(new.workflow_json, '$.title'), 'Workflow'),
        coalesce(json_extract(new.workflow_json, '${workflow.promptPath}'), ''),
        coalesce(json_extract(new.workflow_json, '$.createdAt'), new.updated_at)
      WHERE new.deleted_at IS NULL
        AND json_extract(new.workflow_json, '$.deletedAt') IS NULL;
    `;
    yield* sourceTrigger(`search_${workflow.source}_insert`, workflow.source, body);
    yield* sourceUpdateTrigger(`search_${workflow.source}_update`, workflow.source, body);
    yield* sourceDeleteTrigger(
      `search_${workflow.source}_delete`,
      workflow.source,
      `'workflow.${workflow.prefix}:' || old.workflow_id`,
    );
  }

  // Backfill existing state. Source triggers keep all subsequent projection
  // writes synchronized transactionally.
  yield* sql`DELETE FROM search_documents`;
  yield* sql`
    INSERT INTO search_documents (
      document_key, kind, entity_id, project_id, thread_id, title, content, created_at
    )
    SELECT
      'thread:' || thread_id, 'thread', thread_id, project_id, thread_id,
      title, trim(title || ' ' || coalesce(branch, '')), last_interaction_at
    FROM projection_threads
    WHERE deleted_at IS NULL
  `;
  yield* sql`
    INSERT INTO search_documents (
      document_key, kind, entity_id, project_id, thread_id, message_id, turn_id,
      title, content, role, created_at
    )
    SELECT
      'message:' || message.message_id, 'message', message.message_id, thread.project_id,
      message.thread_id, message.message_id, message.turn_id, thread.title, message.text,
      message.role, message.created_at
    FROM projection_thread_messages AS message
    JOIN projection_threads AS thread ON thread.thread_id = message.thread_id
    WHERE thread.deleted_at IS NULL
      AND message.role IN ('user', 'assistant')
      AND length(trim(message.text)) > 0
  `;
  yield* sql`
    INSERT INTO search_documents (
      document_key, kind, entity_id, project_id, thread_id, turn_id,
      title, content, created_at
    )
    SELECT
      'activity:' || activity.activity_id, 'activity', activity.activity_id, thread.project_id,
      activity.thread_id, activity.turn_id, activity.summary, activity.summary, activity.created_at
    FROM projection_thread_activities AS activity
    JOIN projection_threads AS thread ON thread.thread_id = activity.thread_id
    WHERE thread.deleted_at IS NULL AND length(trim(activity.summary)) > 0
  `;
  yield* sql`
    INSERT INTO search_documents (
      document_key, kind, entity_id, project_id, thread_id, turn_id, file_change_id,
      title, content, path, created_at
    )
    SELECT
      'file-change:' || change.file_change_id, 'fileChange', change.file_change_id,
      thread.project_id, change.thread_id, change.turn_id, change.file_change_id,
      coalesce(change.title, 'Changed files'), coalesce(change.detail, ''),
      change.changed_files, change.started_at
    FROM projection_thread_file_changes AS change
    JOIN projection_threads AS thread ON thread.thread_id = change.thread_id
    WHERE thread.deleted_at IS NULL
  `;

  for (const workflow of workflowSources) {
    if (!existingWorkflowSources.has(workflow.source)) continue;
    yield* sql.unsafe(`
      INSERT INTO search_documents (
        document_key, kind, entity_id, project_id, workflow_id, title, content, created_at
      )
      SELECT
        'workflow.${workflow.prefix}:' || workflow_id,
        'workflow.${workflow.prefix}', workflow_id, project_id, workflow_id,
        coalesce(json_extract(workflow_json, '$.title'), 'Workflow'),
        coalesce(json_extract(workflow_json, '${workflow.promptPath}'), ''),
        coalesce(json_extract(workflow_json, '$.createdAt'), updated_at)
      FROM ${workflow.source}
      WHERE deleted_at IS NULL AND json_extract(workflow_json, '$.deletedAt') IS NULL
    `);
  }
});
