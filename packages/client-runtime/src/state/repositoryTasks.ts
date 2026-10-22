import { REPOSITORY_TASK_METHODS } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { Atom } from "effect/reactivity";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createRepositoryTaskEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    groups: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:repository-tasks:groups",
      tag: REPOSITORY_TASK_METHODS.groupsList,
      staleTimeMs: 30_000,
    }),
    tasks: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:repository-tasks:list",
      tag: REPOSITORY_TASK_METHODS.tasksList,
      staleTimeMs: 10_000,
    }),
    task: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:repository-tasks:detail",
      tag: REPOSITORY_TASK_METHODS.tasksGet,
      staleTimeMs: 0,
    }),
    mergePreview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:repository-tasks:merge-preview",
      tag: REPOSITORY_TASK_METHODS.tasksMergePreview,
      staleTimeMs: 0,
    }),
    taskUpdates: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:repository-tasks:updates",
      tag: REPOSITORY_TASK_METHODS.tasksSubscribe,
      idleTtlMs: 0,
    }),
    upsertGroup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:repository-tasks:group-upsert",
      tag: REPOSITORY_TASK_METHODS.groupsUpsert,
      scheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    setRoleModels: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:repository-tasks:role-models",
      tag: REPOSITORY_TASK_METHODS.roleModelsSet,
      scheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    deleteGroup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:repository-tasks:group-delete",
      tag: REPOSITORY_TASK_METHODS.groupsDelete,
      scheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    createTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:repository-tasks:create",
      tag: REPOSITORY_TASK_METHODS.tasksCreate,
      scheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    stopTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:repository-tasks:stop",
      tag: REPOSITORY_TASK_METHODS.tasksStop,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.taskId]),
      },
    }),
    acknowledgeTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:repository-tasks:acknowledge",
      tag: REPOSITORY_TASK_METHODS.tasksAcknowledge,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.taskId]),
      },
    }),
    archiveTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:repository-tasks:archive",
      tag: REPOSITORY_TASK_METHODS.tasksArchive,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.taskId]),
      },
    }),
    unarchiveTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:repository-tasks:unarchive",
      tag: REPOSITORY_TASK_METHODS.tasksUnarchive,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.taskId]),
      },
    }),
    applyMerge: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:repository-tasks:merge-apply",
      tag: REPOSITORY_TASK_METHODS.tasksMergeApply,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.taskId]),
      },
    }),
  };
}
