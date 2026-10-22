import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS repository_role_models (
    role TEXT PRIMARY KEY, model_selection_json TEXT NOT NULL
  )`;
});
