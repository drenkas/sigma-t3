import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

const histories = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const upstream = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  const sigma = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM sigma_sql_migrations ORDER BY migration_id
  `;
  return {
    upstream: upstream.map((row) => [row.migration_id, row.name] as const),
    sigma: sigma.map((row) => [row.migration_id, row.name] as const),
  };
});

describe("Sigma migrations", () => {
  it.effect("keep fork tables out of upstream's migration ids", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      assert.deepStrictEqual(yield* histories, {
        upstream: migrationManifest,
        sigma: [[1, "RepositoryTasks"]],
      });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("release id 68 from databases that recorded repository tasks there", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`DROP TABLE sigma_sql_migrations`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (68, 'RepositoryTasks')`;
      yield* sql`INSERT INTO repository_groups (id, payload_json) VALUES ('kept', '{}')`;

      yield* runMigrations();

      assert.deepStrictEqual(yield* histories, {
        upstream: migrationManifest,
        sigma: [[1, "RepositoryTasks"]],
      });
      const groups = yield* sql<{ readonly id: string }>`SELECT id FROM repository_groups`;
      assert.deepStrictEqual(
        groups.map((row) => row.id),
        ["kept"],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
