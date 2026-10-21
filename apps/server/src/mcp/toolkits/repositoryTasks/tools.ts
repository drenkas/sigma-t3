import {
  RepositoryTask,
  RepositoryTaskDispatchInput,
  RepositoryTaskIdInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as RepositoryTasks from "../../../repositoryTasks/RepositoryTasks.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  RepositoryTasks.RepositoryTasks,
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
];
const Dispatch = Tool.make("repository_task_dispatch", {
  description:
    "Dispatch one snapshotted repository participant in the repository task this coordinator owns. Select an advertised role from the task snapshot. The server binds an ordinary top-level thread to that repository's workspace, applies the exact role model/options, and delivers its persisted result to this coordinator automatically. Repeating identical input returns the original thread; changing a dispatched participant is rejected. Do not use t3_thread_launch for task participants.",
  parameters: RepositoryTaskDispatchInput,
  success: RepositoryTask,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);
const Status = Tool.make("repository_task_status", {
  description:
    "Read this coordinator's repository task, immutable repository and role snapshots, persisted participant states and graph. Waiting or an interrupted participant is not success. Approval decisions remain with their existing holders.",
  parameters: RepositoryTaskIdInput,
  success: RepositoryTask,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const RepositoryTasksToolkit = Toolkit.make(Dispatch, Status);
