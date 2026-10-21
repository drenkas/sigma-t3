import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as RepositoryTasks from "../../../repositoryTasks/RepositoryTasks.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { RepositoryTasksToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(RepositoryTasksToolkit, {
  repository_task_dispatch: McpToolAccess.writesThreads(
    () => [],
    (input) =>
      Effect.gen(function* () {
        const { caller } = yield* readCaller();
        if (caller === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Only the task's live coordinator can dispatch its repositories.",
          });
        const service = yield* RepositoryTasks.RepositoryTasks;
        return yield* service
          .dispatch(input, caller.id)
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorMcpFailure({ code: "invalid_request", message: cause.message }),
            ),
          );
      }),
  ),
  repository_task_status: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const service = yield* RepositoryTasks.RepositoryTasks;
      const task = yield* service
        .get(input.taskId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: cause.message }),
          ),
        );
      if (caller?.id !== task.snapshot.coordinatorThreadId)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "This task belongs to another coordinator.",
        });
      return task;
    }),
  ),
});
