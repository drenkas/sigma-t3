import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A database that lost its fork history must still migrate.
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`;
  if (columns.some((column) => column.name === "description")) return;
  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN description TEXT NOT NULL DEFAULT ''
  `;
});
