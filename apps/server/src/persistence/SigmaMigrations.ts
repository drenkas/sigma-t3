import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0004 from "./SigmaMigrations/004_ProjectAdditionalWorkspaceRoots.ts";
import Migration0005 from "./SigmaMigrations/005_ProjectDescription.ts";

// Fork tables keep their own history table. Upstream numbers its migrations
// sequentially, and the migrator skips every id up to the highest recorded one,
// so a fork migration in effect_sql_migrations would hide upstream's next one.
const run = Migrator.make({});

// Ids 1-3 created the removed repository task tables; databases that ran them keep them.
const sigmaMigrationRecord = {
  "4_ProjectAdditionalWorkspaceRoots": Migration0004,
  "5_ProjectDescription": Migration0005,
};
const sigmaMigrations = Migrator.fromRecord(sigmaMigrationRecord);
const latestSigmaMigrationId = Math.max(
  ...Object.keys(sigmaMigrationRecord).map((key) => Number.parseInt(key, 10)),
);

// Builds before the fork had its own table recorded repository tasks as upstream id 68.
const releasedUpstreamIds = [[68, "RepositoryTasks"]] as const;

/** Runs before upstream migrations so their id checks never see fork entries. */
export const releaseSigmaUpstreamMigrationIds = Effect.fn("releaseSigmaUpstreamMigrationIds")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
    if (tables.length === 0) return;
    for (const [id, name] of releasedUpstreamIds) {
      // Even a DELETE that matches nothing takes the write lock, which CLI startup must not need.
      const held = yield* sql`
        SELECT 1 FROM effect_sql_migrations WHERE migration_id = ${id} AND name = ${name}
      `;
      if (held.length > 0) {
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${id} AND name = ${name}`;
      }
    }
  },
);

// Mirrors the Migrator, which runs only ids above the highest recorded in its table.
const hasPendingSigmaMigrations = Effect.fn("hasPendingSigmaMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sigma_sql_migrations'
  `;
  if (tables.length === 0) return true;
  const rows = yield* sql<{
    readonly latestId: number | null;
  }>`SELECT MAX(migration_id) AS latestId FROM sigma_sql_migrations`;
  return (rows[0]?.latestId ?? 0) < latestSigmaMigrationId;
});

export const runSigmaMigrations = Effect.fn("runSigmaMigrations")(function* () {
  // The Migrator takes the write lock even when nothing is pending; CLI startup must not.
  if (!(yield* hasPendingSigmaMigrations())) return [];
  const executed = yield* run({ loader: sigmaMigrations, table: "sigma_sql_migrations" });
  if (executed.length > 0)
    yield* Effect.log("Sigma migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  return executed;
});
