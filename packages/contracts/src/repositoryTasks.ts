import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";
import { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "./orchestrationV2.ts";
import { OrchestratorMcpTaskRole } from "./orchestratorMcp.ts";

const Id = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9:_-]+$/),
);
const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Prompt = TrimmedNonEmptyString.check(Schema.isMaxLength(120000));
export const RepositoryTaskRole = Schema.Struct({
  role: OrchestratorMcpTaskRole,
  modelSelection: ModelSelection,
});
export type RepositoryTaskRole = typeof RepositoryTaskRole.Type;
// One model per role, each role at most once.
export const RepositoryRoleModels = Schema.Array(RepositoryTaskRole).check(
  Schema.makeFilter((roles) => new Set(roles.map((entry) => entry.role)).size === roles.length, {
    expected: "each role at most once",
  }),
);
export const RepositoryGroup = Schema.Struct({
  id: Id,
  title: Title,
  projectIds: Schema.Array(ProjectId),
  // Overrides the environment's role models for tasks started from this group.
  roleModels: Schema.optionalKey(RepositoryRoleModels),
  updatedAt: IsoDateTime,
});
export type RepositoryGroup = typeof RepositoryGroup.Type;
export const RepositoryGroupUpsertInput = Schema.Struct({
  id: Id,
  title: Title,
  projectIds: Schema.Array(ProjectId).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  roleModels: Schema.optionalKey(RepositoryRoleModels),
});
export const RepositoryRoleModelsInput = Schema.Struct({ roles: RepositoryRoleModels });
export type RepositoryGroupUpsertInput = typeof RepositoryGroupUpsertInput.Type;
export const RepositoryGroupIdInput = Schema.Struct({ id: Id });
export const RepositoryTaskMemberInput = Schema.Struct({
  projectId: ProjectId,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
});
export const RepositoryTaskCreateInput = Schema.Struct({
  id: Id,
  groupId: Id,
  title: Title,
  prompt: Prompt,
  coordinatorProjectId: ProjectId,
  modelSelection: ModelSelection,
  roles: Schema.Array(RepositoryTaskRole).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  members: Schema.Array(RepositoryTaskMemberInput).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
});
export type RepositoryTaskCreateInput = typeof RepositoryTaskCreateInput.Type;
export const RepositoryTaskMemberSnapshot = Schema.Struct({
  ...RepositoryTaskMemberInput.fields,
  workspaceRoot: TrimmedNonEmptyString,
  startingRevision: TrimmedNonEmptyString,
  threadId: ThreadId,
});
export type RepositoryTaskMemberSnapshot = typeof RepositoryTaskMemberSnapshot.Type;
export const RepositoryTaskSnapshot = Schema.Struct({
  ...RepositoryTaskCreateInput.fields,
  groupTitle: Title,
  coordinatorThreadId: ThreadId,
  coordinatorWorkspaceProjectId: ProjectId,
  members: Schema.Array(RepositoryTaskMemberSnapshot),
  createdAt: IsoDateTime,
});
export type RepositoryTaskSnapshot = typeof RepositoryTaskSnapshot.Type;
export const RepositoryTaskIdInput = Schema.Struct({ taskId: Id });
export const RepositoryTaskListInput = Schema.Struct({ archived: Schema.optional(Schema.Boolean) });
export const RepositoryTaskDispatchInput = Schema.Struct({
  taskId: Id,
  projectId: ProjectId,
  role: OrchestratorMcpTaskRole,
  prompt: Prompt,
});
export type RepositoryTaskDispatchInput = typeof RepositoryTaskDispatchInput.Type;
export const RepositoryTaskGraphNode = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: Schema.NullOr(ThreadId),
  kind: Schema.Literals(["coordinator", "repository", "agent"]),
  origin: Schema.optional(Schema.Literals(["app_owned", "provider_native"])),
  title: Schema.String,
  role: Schema.NullOr(Schema.String),
  modelSelection: Schema.NullOr(ModelSelection),
  status: Schema.String,
  // A tool approval (not a question) is waiting on the user in this node's thread.
  pendingApproval: Schema.Boolean,
});
export const RepositoryTaskGraphEdge = Schema.Struct({
  id: TrimmedNonEmptyString,
  source: TrimmedNonEmptyString,
  target: TrimmedNonEmptyString,
  kind: Schema.Literals([
    "membership",
    "delegation",
    "result",
    "context_transfer",
    "merge",
    // Messages one node received, typed by how orchestration took them in.
    "prompt",
    "steer",
    "follow_up",
  ]),
  status: Schema.String,
  // Timeline position among the task's timed links, recomputed from persisted records so it
  // stays the same across restarts. Links with no recorded time have neither.
  sequence: Schema.NullOr(PositiveInt),
  at: Schema.NullOr(IsoDateTime),
});
export const RepositoryTaskMerge = Schema.Struct({
  sourceThreadId: ThreadId,
  worktreePath: Schema.String,
  // "uncertain": the server stopped while writing; acknowledgement settles it from the files.
  status: Schema.Literals(["applying", "applied", "empty", "conflict", "failed", "uncertain"]),
  files: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type RepositoryTaskMerge = typeof RepositoryTaskMerge.Type;
export const RepositoryTaskMergeInput = Schema.Struct({ taskId: Id, sourceThreadId: ThreadId });
export const RepositoryTaskMergeApplyInput = Schema.Struct({
  ...RepositoryTaskMergeInput.fields,
  // Names the reviewed preview, so a workspace that changed since then is refused.
  token: TrimmedNonEmptyString,
});
export const RepositoryTaskMergePreview = Schema.Struct({
  sourceThreadId: ThreadId,
  // "applied" shows what was written; the rest are planned again from the files now.
  status: Schema.Literals(["applied", "ready", "conflict", "empty"]),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      // A ready path carries a unified patch, a conflicted one its root / base / worker text.
      status: Schema.Literals(["ready", "conflict"]),
      text: Schema.NullOr(Schema.String),
    }),
  ),
  token: Schema.NullOr(TrimmedNonEmptyString),
});
export type RepositoryTaskMergePreview = typeof RepositoryTaskMergePreview.Type;
export const RepositoryTaskMember = Schema.Struct({
  snapshot: RepositoryTaskMemberSnapshot,
  role: Schema.NullOr(Schema.String),
  // "abandoned": an uncertain launch the user acknowledged as never having started.
  launchState: Schema.Literals(["pending", "dispatching", "dispatched", "uncertain", "abandoned"]),
  status: Schema.String,
  runId: Schema.NullOr(RunId),
  workspacePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  preparedRevision: Schema.NullOr(Schema.String),
  pendingApproval: Schema.Boolean,
  deliveryState: Schema.Literals(["pending", "delivering", "delivered", "disposed"]),
  merges: Schema.Array(RepositoryTaskMerge),
});
export const RepositoryTask = Schema.Struct({
  snapshot: RepositoryTaskSnapshot,
  state: Schema.Literals(["active", "finished", "stopping", "stopped", "uncertain"]),
  status: Schema.Literals([
    "pending",
    "running",
    "waiting",
    "completed",
    "failed",
    "interrupted",
    "stopping",
    "stopped",
    "uncertain",
  ]),
  coordinatorStatus: Schema.String,
  archivedAt: Schema.NullOr(IsoDateTime),
  members: Schema.Array(RepositoryTaskMember),
  graph: Schema.Struct({
    nodes: Schema.Array(RepositoryTaskGraphNode),
    edges: Schema.Array(RepositoryTaskGraphEdge),
  }),
});
export type RepositoryTask = typeof RepositoryTask.Type;
export class RepositoryTaskError extends Schema.TaggedError<RepositoryTaskError>()(
  "RepositoryTaskError",
  {
    reason: Schema.Literals([
      "invalid",
      "not-found",
      "conflict",
      "unavailable",
      "scratch-unavailable",
      "persistence",
      "execution",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "scratch-unavailable")
      return "Repository tasks require a data directory outside a Git checkout. Restart Sigma T3 with a data directory outside the repository.";
    return `Repository task operation failed (${this.reason}).`;
  }
}
export const REPOSITORY_TASK_METHODS = {
  groupsList: "repositoryGroups.list",
  groupsUpsert: "repositoryGroups.upsert",
  groupsDelete: "repositoryGroups.delete",
  roleModelsSet: "repositoryGroups.setRoleModels",
  tasksList: "repositoryTasks.list",
  tasksCreate: "repositoryTasks.create",
  tasksGet: "repositoryTasks.get",
  tasksStop: "repositoryTasks.stop",
  tasksAcknowledge: "repositoryTasks.acknowledge",
  tasksArchive: "repositoryTasks.archive",
  tasksUnarchive: "repositoryTasks.unarchive",
  tasksMergePreview: "repositoryTasks.mergePreview",
  tasksMergeApply: "repositoryTasks.mergeApply",
  tasksSubscribe: "repositoryTasks.subscribe",
} as const;
