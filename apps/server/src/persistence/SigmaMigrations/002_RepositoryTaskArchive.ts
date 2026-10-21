import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Like 001's IF NOT EXISTS: a database that lost its fork history must still migrate.
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(repository_tasks)`;
  if (columns.some((column) => column.name === "archived_at")) return;
  yield* sql`ALTER TABLE repository_tasks ADD COLUMN archived_at TEXT`;
});
