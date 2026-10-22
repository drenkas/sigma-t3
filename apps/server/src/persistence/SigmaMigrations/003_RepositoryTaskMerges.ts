import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS repository_task_merges (
    task_id TEXT NOT NULL REFERENCES repository_tasks(id), project_id TEXT NOT NULL,
    source_thread_id TEXT NOT NULL, worktree_path TEXT NOT NULL, status TEXT NOT NULL,
    base_commit TEXT, ours_tree TEXT, merged_tree TEXT, files_json TEXT NOT NULL DEFAULT '[]',
    error TEXT, ordinal INTEGER NOT NULL,
    PRIMARY KEY (task_id, source_thread_id)
  )`;
});
