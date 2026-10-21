import { REPOSITORY_TASK_METHODS, WsRepositoryTasksRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as RepositoryTasks from "./RepositoryTasks.ts";

// Served as its own group beside ws.ts's: one merged handler object exceeds the
// type checker's instantiation depth, and a separate file keeps upstream's ws.ts
// merge-friendly.
export const ServerRepositoryTasksRpcGroup =
  WsRepositoryTasksRpcGroup.middleware(RpcInstrumentation);

export const layer = ServerRepositoryTasksRpcGroup.toLayer(
  Effect.map(RepositoryTasks.RepositoryTasks, (tasks) =>
    ServerRepositoryTasksRpcGroup.of({
      [REPOSITORY_TASK_METHODS.groupsList]: () =>
        tasks.listGroups.pipe(Effect.map((groups) => ({ groups }))),
      [REPOSITORY_TASK_METHODS.groupsUpsert]: (input) => tasks.upsertGroup(input),
      [REPOSITORY_TASK_METHODS.groupsDelete]: ({ id }) => tasks.deleteGroup(id).pipe(Effect.as({})),
      [REPOSITORY_TASK_METHODS.tasksList]: () =>
        tasks.listTasks.pipe(Effect.map((list) => ({ tasks: list }))),
      [REPOSITORY_TASK_METHODS.tasksCreate]: (input) => tasks.create(input),
      [REPOSITORY_TASK_METHODS.tasksGet]: ({ taskId }) => tasks.get(taskId),
      [REPOSITORY_TASK_METHODS.tasksSubscribe]: ({ taskId }) => tasks.subscribe(taskId),
      [REPOSITORY_TASK_METHODS.tasksStop]: ({ taskId }) => tasks.stop(taskId),
    }),
  ),
);
