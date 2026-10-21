import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0001 from "./SigmaMigrations/001_RepositoryTasks.ts";
import Migration0002 from "./SigmaMigrations/002_RepositoryTaskArchive.ts";

// Fork tables keep their own history table. Upstream numbers its migrations
// sequentially, and the migrator skips every id up to the highest recorded one,
// so a fork migration in effect_sql_migrations would hide upstream's next one.
const run = Migrator.make({});

const sigmaMigrations = Migrator.fromRecord({
  "1_RepositoryTasks": Migration0001,
  "2_RepositoryTaskArchive": Migration0002,
});

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
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${id} AND name = ${name}`;
    }
  },
);

export const runSigmaMigrations = Effect.fn("runSigmaMigrations")(function* () {
  const executed = yield* run({ loader: sigmaMigrations, table: "sigma_sql_migrations" });
  if (executed.length > 0)
    yield* Effect.log("Sigma migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  return executed;
});
