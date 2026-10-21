import { RepositoryTaskError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as WorkspacePreparationObserver from "../orchestration-v2/WorkspacePreparationObserver.ts";

export class RepositoryTaskAdmission extends Context.Service<
  RepositoryTaskAdmission,
  {
    readonly withLock: KeyedLock.KeyedLock<string>["withLock"];
    readonly beforeRelease: WorkspacePreparationObserver.WorkspacePreparationObserverService["beforeRelease"];
  }
>()("t3/repositoryTasks/RepositoryTaskAdmission") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const locks = yield* KeyedLock.make<string>();
  const beforeRelease: WorkspacePreparationObserver.WorkspacePreparationObserverService["beforeRelease"] =
    Effect.fn("RepositoryTaskAdmission.beforeRelease")(function* (threadId, cwd, release) {
      const owners = yield* sql<{ task_id: string; direct_member: number }>`
      SELECT task_id, 1 AS direct_member FROM repository_task_members WHERE thread_id = ${threadId}
      UNION ALL SELECT id AS task_id, 0 AS direct_member FROM repository_tasks WHERE coordinator_thread_id = ${threadId}
      UNION ALL SELECT member.task_id, 0 AS direct_member FROM orchestration_v2_projection_threads AS thread
        JOIN repository_task_members AS member ON member.thread_id = json_extract(thread.payload_json, '$.lineage.rootThreadId')
        WHERE thread.thread_id = ${threadId} AND thread.thread_id != member.thread_id
      UNION ALL SELECT task.id AS task_id, 0 AS direct_member FROM orchestration_v2_projection_threads AS thread
        JOIN repository_tasks AS task ON task.coordinator_thread_id = json_extract(thread.payload_json, '$.lineage.rootThreadId')
        WHERE thread.thread_id = ${threadId} AND thread.thread_id != task.coordinator_thread_id
    `.pipe(Effect.mapError((cause) => new RepositoryTaskError({ reason: "persistence", cause })));
      if (!owners[0]) return yield* release;
      const taskId = owners[0].task_id;
      return yield* locks.withLock(
        taskId,
        Effect.gen(function* () {
          const states = yield* sql<{
            state: string;
          }>`SELECT state FROM repository_tasks WHERE id = ${taskId}`.pipe(
            Effect.mapError((cause) => new RepositoryTaskError({ reason: "persistence", cause })),
          );
          if (states[0]?.state === "finished") return yield* release;
          if (states[0]?.state !== "active")
            return yield* new RepositoryTaskError({ reason: "conflict" });
          if (owners[0]!.direct_member !== 1) return yield* release;
          const preparedPath = yield* fs
            .realPath(cwd)
            .pipe(
              Effect.mapError((cause) => new RepositoryTaskError({ reason: "execution", cause })),
            );
          const revision = yield* git
            .resolveCommit({ cwd: preparedPath, revision: "HEAD" })
            .pipe(
              Effect.mapError((cause) => new RepositoryTaskError({ reason: "execution", cause })),
            );
          yield* sql`UPDATE repository_task_members SET prepared_path = ${preparedPath}, prepared_revision = ${revision.commitSha}
        WHERE task_id = ${taskId} AND thread_id = ${threadId}`.pipe(
            Effect.mapError((cause) => new RepositoryTaskError({ reason: "persistence", cause })),
          );
          return yield* release;
        }),
      );
    });
  return { withLock: locks.withLock, beforeRelease };
});
export const layer = Layer.effect(RepositoryTaskAdmission, make);
export const layerObserver = Layer.effect(
  WorkspacePreparationObserver.WorkspacePreparationObserver,
  Effect.map(RepositoryTaskAdmission, (admission) => ({ beforeRelease: admission.beforeRelease })),
);
