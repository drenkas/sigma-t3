import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE repository_groups (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE repository_tasks (
    id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, request_json TEXT NOT NULL,
    state TEXT NOT NULL, coordinator_thread_id TEXT NOT NULL UNIQUE
  )`;
  yield* sql`CREATE TABLE repository_task_members (
    task_id TEXT NOT NULL REFERENCES repository_tasks(id), project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL UNIQUE, role TEXT, prompt TEXT,
    launch_state TEXT NOT NULL DEFAULT 'pending',
    delivery_state TEXT NOT NULL DEFAULT 'pending', result_run_id TEXT,
    prepared_path TEXT, prepared_revision TEXT,
    PRIMARY KEY (task_id, project_id)
  )`;
});
