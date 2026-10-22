import {
  CommandId,
  MessageId,
  ThreadId,
  RepositoryGroup,
  RepositoryTaskSnapshot,
  RepositoryTaskError,
  type RepositoryGroupUpsertInput,
  RepositoryTaskCreateInput,
  type RepositoryTaskDispatchInput,
  type RepositoryTask,
  type RepositoryTaskMemberSnapshot,
  type RepositoryTaskMerge,
  type ModelSelection,
  type ProjectId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  isOrchestrationV2WorkActive,
  isProviderAvailable,
} from "@t3tools/contracts";
import { pathsOverlap } from "./paths.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Admission from "./RepositoryTaskAdmission.ts";
import * as Merge from "./RepositoryTaskMerge.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";

type TaskRow = {
  id: string;
  snapshot_json: string;
  request_json: string;
  state: RepositoryTask["state"];
  archived_at: string | null;
};
type MemberRow = {
  task_id: string;
  project_id: ProjectId;
  thread_id: ThreadId;
  role: string | null;
  prompt: string | null;
  launch_state: RepositoryTask["members"][number]["launchState"];
  delivery_state: RepositoryTask["members"][number]["deliveryState"];
  result_run_id: string | null;
  prepared_path: string | null;
  prepared_revision: string | null;
};
type MergeRow = {
  task_id: string;
  project_id: ProjectId;
  source_thread_id: ThreadId;
  worktree_path: string;
  status: RepositoryTaskMerge["status"];
  base_commit: string | null;
  ours_tree: string | null;
  merged_tree: string | null;
  files_json: string;
  error: string | null;
};
// Only these let a task finish; the rest need the user's attention first.
const settledMerge = (status: RepositoryTaskMerge["status"]) =>
  status === "applied" || status === "empty";
const MergeFiles = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeMergeFiles = Schema.decodeSync(MergeFiles);
const encodeMergeFiles = Schema.encodeSync(MergeFiles);
const decodeGroup = Schema.decodeUnknownEffect(Schema.fromJsonString(RepositoryGroup));
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(RepositoryTaskSnapshot));
const isRepositoryTaskError = Schema.is(RepositoryTaskError);
const encodeGroup = Schema.encodeSync(Schema.fromJsonString(RepositoryGroup));
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(RepositoryTaskSnapshot));
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(RepositoryTaskCreateInput));
const fail = (reason: RepositoryTaskError["reason"], cause?: unknown) =>
  new RepositoryTaskError({ reason, ...(cause === undefined ? {} : { cause }) });
const persistenceError = (cause: unknown) => fail("persistence", cause);
const executionError = (cause: unknown) =>
  isRepositoryTaskError(cause) ? cause : fail("execution", cause);
const terminal = (run: OrchestrationV2Run) =>
  ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(run.status);
const latestRun = (projection: Pick<OrchestrationV2ThreadProjection, "runs">) =>
  projection.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
const command = (taskId: string, suffix: string) =>
  CommandId.make(`repository-task:${taskId}:${suffix}`);
const message = (taskId: string, suffix: string) =>
  MessageId.make(`repository-task:${taskId}:${suffix}`);

export class RepositoryTasks extends Context.Service<
  RepositoryTasks,
  {
    readonly subscribe: (taskId: string) => Stream.Stream<RepositoryTask, RepositoryTaskError>;
    readonly notifyChanged: Effect.Effect<void>;
    readonly listGroups: Effect.Effect<ReadonlyArray<RepositoryGroup>, RepositoryTaskError>;
    readonly upsertGroup: (
      input: RepositoryGroupUpsertInput,
    ) => Effect.Effect<RepositoryGroup, RepositoryTaskError>;
    readonly deleteGroup: (id: string) => Effect.Effect<void, RepositoryTaskError>;
    readonly listTasks: (input: {
      readonly archived: boolean;
    }) => Effect.Effect<ReadonlyArray<RepositoryTask>, RepositoryTaskError>;
    readonly create: (
      input: RepositoryTaskCreateInput,
    ) => Effect.Effect<RepositoryTask, RepositoryTaskError>;
    readonly get: (taskId: string) => Effect.Effect<RepositoryTask, RepositoryTaskError>;
    readonly dispatch: (
      input: RepositoryTaskDispatchInput,
      callerThreadId: ThreadId,
    ) => Effect.Effect<RepositoryTask, RepositoryTaskError>;
    readonly stop: (taskId: string) => Effect.Effect<RepositoryTask, RepositoryTaskError>;
    /** Settles uncertain launches from what was persisted, without launching anything again. */
    readonly acknowledge: (taskId: string) => Effect.Effect<RepositoryTask, RepositoryTaskError>;
    readonly archive: (taskId: string) => Effect.Effect<RepositoryTask, RepositoryTaskError>;
    readonly unarchive: (taskId: string) => Effect.Effect<RepositoryTask, RepositoryTaskError>;
    readonly reconcile: (taskId: string) => Effect.Effect<void, RepositoryTaskError>;
    readonly recover: Effect.Effect<void, RepositoryTaskError>;
    readonly taskIdsForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<string>, RepositoryTaskError>;
  }
>()("t3/repositoryTasks/RepositoryTasks") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const projects = yield* ProjectService.ProjectService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const adapters = yield* ProviderAdapters.ProviderAdapterRegistryV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
  const locks = yield* Admission.RepositoryTaskAdmission;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const merger = yield* Merge.make;
  const changes = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const readTask = Effect.fn("RepositoryTasks.readTask")(function* (taskId: string) {
    const rows = yield* sql<TaskRow>`SELECT * FROM repository_tasks WHERE id = ${taskId}`.pipe(
      Effect.mapError(persistenceError),
    );
    const row = rows[0];
    if (row === undefined) return yield* fail("not-found");
    const snapshot = yield* decodeSnapshot(row.snapshot_json).pipe(
      Effect.mapError(persistenceError),
    );
    const members =
      yield* sql<MemberRow>`SELECT * FROM repository_task_members WHERE task_id = ${taskId} ORDER BY project_id`.pipe(
        Effect.mapError(persistenceError),
      );
    const merges =
      yield* sql<MergeRow>`SELECT * FROM repository_task_merges WHERE task_id = ${taskId} ORDER BY ordinal`.pipe(
        Effect.mapError(persistenceError),
      );
    return { row, snapshot, members, merges };
  });
  const memberCwd = (member: MemberRow, snap: RepositoryTaskMemberSnapshot) =>
    member.prepared_path ??
    (snap.workspaceStrategy.type === "existing_worktree"
      ? snap.workspaceStrategy.worktreePath
      : snap.workspaceRoot);
  const project = Effect.fn("RepositoryTasks.project")(function* (projectId: ProjectId) {
    const found = yield* projects.getById(projectId).pipe(Effect.mapError(executionError));
    if (Option.isNone(found) || found.value.deletedAt !== null) return yield* fail("not-found");
    return found.value;
  });
  const validateSelection = Effect.fn("RepositoryTasks.validateSelection")(function* (
    projectId: ProjectId,
    selection: ModelSelection,
    runtimeMode: RepositoryTaskCreateInput["runtimeMode"],
  ) {
    const catalog = yield* providers.getProviders;
    const provider = catalog.find((entry) => entry.instanceId === selection.instanceId);
    const registered = yield* adapters.list();
    if (
      !provider ||
      !registered.includes(selection.instanceId) ||
      !isProviderAvailable(provider) ||
      !provider.enabled ||
      !provider.installed ||
      provider.status === "error" ||
      provider.status === "disabled" ||
      provider.auth.status === "unauthenticated" ||
      (provider.supportedRuntimeModes?.length &&
        !provider.supportedRuntimeModes.includes(runtimeMode)) ||
      !(yield* threads.isProviderInstanceEnabledForProject({
        projectId,
        instanceId: selection.instanceId,
      }))
    ) {
      return yield* fail("unavailable");
    }
    const model = provider.models.find((entry) => entry.slug === selection.model);
    if (!model) return yield* fail("unavailable");
    const seen = new Set<string>();
    for (const option of selection.options ?? []) {
      const descriptor = model.capabilities?.optionDescriptors?.find(
        (entry) => entry.id === option.id,
      );
      if (
        seen.has(option.id) ||
        !descriptor ||
        (descriptor.type === "boolean"
          ? typeof option.value !== "boolean"
          : !descriptor.options.some((choice) => choice.id === option.value))
      ) {
        return yield* fail("invalid");
      }
      seen.add(option.id);
    }
  });
  const listGroups = sql<{
    payload_json: string;
  }>`SELECT payload_json FROM repository_groups ORDER BY id`.pipe(
    Effect.mapError(persistenceError),
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        decodeGroup(row.payload_json).pipe(Effect.mapError(persistenceError)),
      ),
    ),
  );
  const upsertGroup = Effect.fn("RepositoryTasks.upsertGroup")(function* (
    input: RepositoryGroupUpsertInput,
  ) {
    if (new Set(input.projectIds).size !== input.projectIds.length) return yield* fail("invalid");
    yield* Effect.forEach(input.projectIds, project);
    const group = { ...input, updatedAt: DateTime.formatIso(yield* DateTime.now) };
    yield* sql`INSERT INTO repository_groups (id, payload_json) VALUES (${group.id}, ${encodeGroup(group)})
      ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json`.pipe(
      Effect.mapError(persistenceError),
    );
    return group;
  });
  const deleteGroup = Effect.fn("RepositoryTasks.deleteGroup")(function* (id: string) {
    yield* sql`DELETE FROM repository_groups WHERE id = ${id}`.pipe(
      Effect.mapError(persistenceError),
    );
  });
  const records = Effect.fn("RepositoryTasks.records")(function* (threadId: ThreadId) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(executionError));
    if (shell === null || shell.deletedAt !== null) return null;
    return yield* threads
      .getThreadRecords(threadId, [
        "runs",
        "subagents",
        "runtimeRequests",
        "providerThreads",
        "messages",
        "contextTransfers",
      ])
      .pipe(Effect.mapError(executionError));
  });
  type Records = NonNullable<Effect.Success<ReturnType<typeof records>>>;
  const settled = (record: Records) => {
    const run = latestRun(record);
    return (
      run !== undefined &&
      terminal(run) &&
      !record.runs.some((entry) => !terminal(entry)) &&
      !record.subagents.some((entry) => isOrchestrationV2WorkActive(entry.status)) &&
      !record.runtimeRequests.some((entry) => entry.status === "pending") &&
      !record.providerThreads.some((entry) => (entry.pendingBackgroundTasks?.length ?? 0) > 0)
    );
  };
  const treeSettled: (
    record: Records,
    seen?: Set<ThreadId>,
  ) => Effect.Effect<boolean, RepositoryTaskError> = Effect.fn("RepositoryTasks.treeSettled")(
    function* (record, seen = new Set()) {
      if (seen.has(record.thread.id)) return true;
      seen.add(record.thread.id);
      if (!settled(record)) return false;
      for (const agent of record.subagents) {
        if (agent.origin !== "app_owned" || agent.childThreadId === null) continue;
        const child = yield* records(agent.childThreadId);
        if (child === null || !(yield* treeSettled(child, seen))) return false;
      }
      return true;
    },
  );
  const status = (record: Records | null) => {
    if (!record) return "missing";
    if (record.runtimeRequests.some((entry) => entry.status === "pending")) return "waiting";
    const run = latestRun(record);
    return run === undefined
      ? "idle"
      : settled(record)
        ? run.status
        : terminal(run)
          ? "waiting"
          : run.status;
  };
  const get = Effect.fn("RepositoryTasks.get")(function* (
    taskId: string,
  ): Effect.fn.Return<RepositoryTask, RepositoryTaskError> {
    const { row, snapshot, members, merges } = yield* readTask(taskId);
    const coordinator = yield* records(snapshot.coordinatorThreadId);
    const graph: {
      nodes: Array<RepositoryTask["graph"]["nodes"][number]>;
      edges: Array<RepositoryTask["graph"]["edges"][number]>;
    } = { nodes: [], edges: [] };
    const coordinatorNode = `thread:${snapshot.coordinatorThreadId}`;
    graph.nodes.push({
      id: coordinatorNode,
      threadId: snapshot.coordinatorThreadId,
      kind: "coordinator",
      title: snapshot.title,
      role: "coordinator",
      modelSelection: coordinator?.thread.modelSelection ?? snapshot.modelSelection,
      status: status(coordinator),
    });
    const visited = new Set<string>([coordinatorNode]);
    const transfers = new Map<string, Records["contextTransfers"][number]>();
    const rememberTransfers = (record: Records) => {
      for (const transfer of record.contextTransfers) transfers.set(transfer.id, transfer);
    };
    if (coordinator !== null) rememberTransfers(coordinator);
    const addAgents: (record: Records, parent: string) => Effect.Effect<void, RepositoryTaskError> =
      Effect.fn("RepositoryTasks.addAgents")(function* (record, parent) {
        rememberTransfers(record);
        for (const agent of record.subagents) {
          const id =
            agent.childThreadId === null ? `agent:${agent.id}` : `thread:${agent.childThreadId}`;
          graph.edges.push({
            id: `delegation:${agent.id}`,
            source: parent,
            target: id,
            kind: "delegation",
            status: agent.status,
          });
          if (visited.has(id)) continue;
          visited.add(id);
          const child = agent.childThreadId === null ? null : yield* records(agent.childThreadId);
          graph.nodes.push({
            id,
            threadId: agent.childThreadId,
            kind: "agent",
            origin: agent.origin,
            title: agent.title ?? "Agent",
            role: agent.role ?? null,
            modelSelection: child?.thread.modelSelection ?? agent.modelSelection ?? null,
            status: child === null ? agent.status : status(child),
          });
          if (child !== null) yield* addAgents(child, id);
        }
      });
    const views: Array<RepositoryTask["members"][number]> = [];
    for (const member of members) {
      const snap = snapshot.members.find((entry) => entry.projectId === member.project_id);
      if (!snap) return yield* fail("persistence");
      const record = yield* records(snap.threadId);
      const id = `thread:${snap.threadId}`;
      const memberMerges = merges
        .filter((merge) => merge.project_id === member.project_id)
        .map((merge) => ({
          sourceThreadId: merge.source_thread_id,
          worktreePath: merge.worktree_path,
          status: merge.status,
          files: decodeMergeFiles(merge.files_json),
          error: merge.error,
        }));
      const blockedMerge = memberMerges.find((merge) => !settledMerge(merge.status));
      const memberStatus =
        blockedMerge !== undefined
          ? `merge_${blockedMerge.status}`
          : member.launch_state === "pending"
            ? "not_started"
            : member.launch_state === "uncertain" || member.launch_state === "abandoned"
              ? member.launch_state
              : record !== null && settled(record) && !(yield* treeSettled(record))
                ? "waiting"
                : status(record);
      views.push({
        snapshot: snap,
        role: member.role,
        launchState: member.launch_state,
        status: memberStatus,
        runId: record === null ? null : (latestRun(record)?.id ?? null),
        preparedRevision: member.prepared_revision,
        workspacePath: member.prepared_path,
        branch: record?.thread.branch ?? null,
        pendingApproval:
          record?.runtimeRequests.some(
            (request) => request.kind !== "user_input" && request.status === "pending",
          ) ?? false,
        deliveryState: member.delivery_state,
        merges: memberMerges,
      });
      graph.nodes.push({
        id,
        threadId: snap.threadId,
        kind: "repository",
        title: snap.workspaceRoot,
        role: member.role,
        modelSelection:
          record?.thread.modelSelection ??
          snapshot.roles.find((role) => role.role === member.role)?.modelSelection ??
          null,
        status: memberStatus,
      });
      visited.add(id);
      graph.edges.push({
        id: `membership:${snap.threadId}`,
        source: coordinatorNode,
        target: id,
        kind: "membership",
        status: memberStatus,
      });
      if (member.delivery_state === "delivered")
        graph.edges.push({
          id: `result:${snap.threadId}`,
          source: id,
          target: coordinatorNode,
          kind: "result",
          status: "delivered",
        });
      if (record !== null) yield* addAgents(record, id);
    }
    if (coordinator !== null) yield* addAgents(coordinator, coordinatorNode);
    for (const transfer of transfers.values()) {
      const source = `thread:${transfer.sourceThreadId}`;
      const target = `thread:${transfer.targetThreadId}`;
      if (visited.has(source) && visited.has(target))
        graph.edges.push({
          id: `context-transfer:${transfer.id}`,
          source,
          target,
          kind: "context_transfer",
          status: transfer.status,
        });
    }
    const coordinatorStatus =
      coordinator !== null && settled(coordinator) && !(yield* treeSettled(coordinator))
        ? "waiting"
        : status(coordinator);
    const finished = row.state === "finished";
    const taskStatus: RepositoryTask["status"] =
      row.state !== "active" && row.state !== "finished"
        ? row.state
        : views.some((member) => member.status === "uncertain")
          ? "uncertain"
          : views.some((member) =>
                ["failed", "cancelled", "rolled_back"].includes(member.status),
              ) || coordinatorStatus === "failed"
            ? "failed"
            : views.some((member) => member.status === "interrupted") ||
                coordinatorStatus === "interrupted"
              ? "interrupted"
              : coordinatorStatus === "completed" &&
                  (finished
                    ? // The coordinator may finish without dispatching every repository.
                      views.every(
                        (member) =>
                          member.launchState === "pending" || member.status === "completed",
                      )
                    : views.length > 0 &&
                      views.every(
                        (member) =>
                          member.status === "completed" && member.deliveryState === "delivered",
                      ))
                ? "completed"
                : finished
                  ? "interrupted"
                  : views.some(
                        (member) =>
                          member.status === "waiting" || member.status.startsWith("merge_"),
                      ) || coordinatorStatus === "waiting"
                    ? "waiting"
                    : views.every((member) => member.launchState === "pending") &&
                        coordinatorStatus === "idle"
                      ? "pending"
                      : "running";
    return {
      snapshot,
      state: row.state,
      status: taskStatus,
      coordinatorStatus,
      archivedAt: row.archived_at,
      members: views,
      graph,
    };
  });

  const create = Effect.fn("RepositoryTasks.create")(
    function* (input: RepositoryTaskCreateInput) {
      const existing =
        yield* sql<TaskRow>`SELECT * FROM repository_tasks WHERE id = ${input.id}`.pipe(
          Effect.mapError(persistenceError),
        );
      if (existing[0]) {
        if (existing[0].request_json !== encodeRequest(input)) return yield* fail("conflict");
        return yield* get(input.id);
      }
      const group = (yield* listGroups).find((entry) => entry.id === input.groupId);
      if (!group) return yield* fail("not-found");
      if (
        new Set(input.members.map((member) => member.projectId)).size !== input.members.length ||
        new Set(input.roles.map((role) => role.role)).size !== input.roles.length ||
        !input.members.every((member) => group.projectIds.includes(member.projectId)) ||
        !group.projectIds.includes(input.coordinatorProjectId)
      )
        return yield* fail("invalid");
      yield* validateSelection(input.coordinatorProjectId, input.modelSelection, input.runtimeMode);
      const members: Array<RepositoryTaskMemberSnapshot> = [];
      const paths = new Set<string>();
      for (const [index, member] of input.members.entries()) {
        const source = yield* project(member.projectId);
        const workspaceRoot = yield* fs
          .realPath(source.workspaceRoot)
          .pipe(Effect.mapError(executionError));
        const strategy = member.workspaceStrategy;
        const cwd =
          strategy.type === "existing_worktree"
            ? yield* fs.realPath(strategy.worktreePath).pipe(Effect.mapError(executionError))
            : workspaceRoot;
        if ([...paths].some((path) => pathsOverlap(path, cwd))) return yield* fail("conflict");
        paths.add(cwd);
        if (strategy.type === "existing_worktree") {
          const worktrees = yield* git
            .listWorktreePaths(workspaceRoot)
            .pipe(Effect.mapError(executionError));
          const canonical = yield* Effect.forEach(worktrees, (path) =>
            fs.realPath(path).pipe(Effect.mapError(executionError)),
          );
          if (!canonical.includes(cwd)) return yield* fail("invalid");
        }
        if (strategy.type === "worktree" && strategy.startFromOrigin === true)
          return yield* fail("invalid");
        const revision = yield* git
          .resolveCommit({
            cwd,
            revision: strategy.type === "worktree" ? strategy.baseRef : "HEAD",
          })
          .pipe(Effect.mapError(executionError));
        for (const role of input.roles)
          yield* validateSelection(member.projectId, role.modelSelection, input.runtimeMode);
        members.push({
          ...member,
          workspaceStrategy:
            strategy.type === "worktree"
              ? { ...strategy, baseRef: revision.commitSha, startFromOrigin: false }
              : strategy.type === "existing_worktree"
                ? { ...strategy, worktreePath: cwd }
                : strategy,
          workspaceRoot,
          startingRevision: revision.commitSha,
          threadId: ThreadId.make(`repository-task:${input.id}:member:${index}`),
        });
      }
      const otherTasks =
        yield* sql<TaskRow>`SELECT * FROM repository_tasks WHERE state IN ('active', 'stopping', 'uncertain')`.pipe(
          Effect.mapError(persistenceError),
        );
      for (const other of otherTasks) {
        const view = yield* get(other.id);
        if (view.status === "completed") continue;
        for (const member of members) {
          if (member.workspaceStrategy.type === "worktree") continue;
          const cwd =
            member.workspaceStrategy.type === "existing_worktree"
              ? member.workspaceStrategy.worktreePath
              : member.workspaceRoot;
          if (
            view.snapshot.members.some(
              (entry) =>
                entry.workspaceStrategy.type !== "worktree" &&
                (() => {
                  const path =
                    entry.workspaceStrategy.type === "existing_worktree"
                      ? entry.workspaceStrategy.worktreePath
                      : entry.workspaceRoot;
                  return pathsOverlap(path, cwd);
                })(),
            )
          )
            return yield* fail("conflict");
        }
      }
      const scratch = yield* managedFolders.ensureScratchProject.pipe(
        Effect.catchTags({ ScratchUnavailableError: () => fail("scratch-unavailable") }),
        Effect.mapError(executionError),
      );
      yield* validateSelection(scratch.projectId, input.modelSelection, input.runtimeMode);
      const snapshot: RepositoryTaskSnapshot = {
        ...input,
        coordinatorWorkspaceProjectId: scratch.projectId,
        groupTitle: group.title,
        members,
        coordinatorThreadId: ThreadId.make(`repository-task:${input.id}:coordinator`),
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO repository_tasks (id, snapshot_json, request_json, state, coordinator_thread_id) VALUES (${input.id}, ${encodeSnapshot(snapshot)}, ${encodeRequest(input)}, 'active', ${snapshot.coordinatorThreadId})`;
            for (const member of members)
              yield* sql`INSERT INTO repository_task_members (task_id, project_id, thread_id) VALUES (${input.id}, ${member.projectId}, ${member.threadId})`;
          }),
        )
        .pipe(Effect.mapError(persistenceError));
      yield* launches
        .launch({
          commandId: command(input.id, "coordinator"),
          threadId: snapshot.coordinatorThreadId,
          projectId: snapshot.coordinatorWorkspaceProjectId,
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          workspaceStrategy: { type: "root" },
          createdBy: "user",
          creationSource: "server",
          initialMessage: {
            messageId: message(input.id, "coordinator"),
            attachments: [],
            text: `Coordinate repository task ${input.id}. Use repository_task_dispatch for every selected project, then wait for persisted results. Do not perform implementation in the coordinator checkout. Each repository keeps its own Git state; do not commit, merge, push or overwrite others' work without the user's authorization. A task succeeds only when all repository participants succeeded.\nSelected projects: ${members.map((member) => member.projectId).join(", ")}.\nAvailable roles: ${input.roles.map((role) => role.role).join(", ")}.\n\n${input.prompt}`,
          },
        })
        .pipe(
          Effect.mapError(executionError),
          Effect.tapError(() =>
            sql`UPDATE repository_tasks SET state = 'uncertain' WHERE id = ${input.id}`.pipe(
              Effect.mapError(persistenceError),
            ),
          ),
        );
      yield* notifyChanged;
      return yield* get(input.id);
    },
    (effect, input) => locks.withLock("repository-task:create", locks.withLock(input.id, effect)),
  );

  const dispatch = Effect.fn("RepositoryTasks.dispatch")(
    function* (input: RepositoryTaskDispatchInput, callerThreadId: ThreadId) {
      const { row, snapshot, members } = yield* readTask(input.taskId);
      if (callerThreadId !== snapshot.coordinatorThreadId) return yield* fail("invalid");
      if (row.state !== "active") return yield* fail("conflict");
      const limit = yield* DispatchModeLimit;
      if (limit !== undefined && exceededDispatchModeLimit(limit, snapshot) !== undefined)
        return yield* fail("invalid");
      const member = members.find((entry) => entry.project_id === input.projectId);
      const snap = snapshot.members.find((entry) => entry.projectId === input.projectId);
      const role = snapshot.roles.find((entry) => entry.role === input.role);
      if (!member || !snap || !role) return yield* fail("invalid");
      if (member.launch_state !== "pending") {
        if (
          member.role !== input.role ||
          member.prompt !== input.prompt ||
          member.launch_state === "uncertain" ||
          member.launch_state === "abandoned"
        )
          return yield* fail("conflict");
        return yield* get(input.taskId);
      }
      const currentProject = yield* project(snap.projectId);
      if (
        (yield* fs.realPath(currentProject.workspaceRoot).pipe(Effect.mapError(executionError))) !==
        snap.workspaceRoot
      )
        return yield* fail("conflict");
      if (snap.workspaceStrategy.type !== "worktree") {
        const cwd =
          snap.workspaceStrategy.type === "existing_worktree"
            ? snap.workspaceStrategy.worktreePath
            : snap.workspaceRoot;
        const shells = yield* threads.getShellSnapshot().pipe(Effect.mapError(executionError));
        for (const shell of shells.threads) {
          if (
            shell.id === snap.threadId ||
            shell.deletedAt !== null ||
            shell.archivedAt !== null ||
            (!shell.activeRunId &&
              !shell.activityRunStatus &&
              (shell.pendingBackgroundTasks?.length ?? 0) === 0)
          )
            continue;
          const source = yield* projects
            .getById(shell.projectId)
            .pipe(Effect.mapError(executionError));
          // A thread whose project was deleted holds no checkout this task could collide with.
          if (Option.isNone(source) || source.value.deletedAt !== null) continue;
          const otherCwd = yield* fs
            .realPath(shell.worktreePath ?? source.value.workspaceRoot)
            .pipe(Effect.mapError(executionError));
          if (pathsOverlap(otherCwd, cwd)) return yield* fail("conflict");
        }
      }
      yield* validateSelection(snap.projectId, role.modelSelection, snapshot.runtimeMode);
      const strategy = snap.workspaceStrategy;
      if (strategy.type !== "worktree") {
        const head = yield* git
          .resolveCommit({
            cwd: strategy.type === "existing_worktree" ? strategy.worktreePath : snap.workspaceRoot,
            revision: "HEAD",
          })
          .pipe(Effect.mapError(executionError));
        if (head.commitSha !== snap.startingRevision) return yield* fail("conflict");
      }
      yield* sql`UPDATE repository_task_members SET launch_state = 'dispatching', role = ${input.role}, prompt = ${input.prompt} WHERE task_id = ${input.taskId} AND project_id = ${input.projectId}`.pipe(
        Effect.mapError(persistenceError),
      );
      yield* launches
        .launch({
          commandId: command(input.taskId, `launch:${snap.threadId}`),
          threadId: snap.threadId,
          projectId: snap.projectId,
          title: `${snapshot.title} · ${input.role}`,
          modelSelection: role.modelSelection,
          runtimeMode: snapshot.runtimeMode,
          interactionMode: snapshot.interactionMode,
          workspaceStrategy: snap.workspaceStrategy,
          initialMessage: {
            messageId: message(input.taskId, `launch:${snap.threadId}`),
            senderThreadId: snapshot.coordinatorThreadId,
            text: `Role: ${input.role}. Work only in this repository. Preserve unrelated changes. Do not commit, merge or push unless the user authorized it. Your final result is delivered to the coordinator automatically.\n\n${input.prompt}`,
            attachments: [],
          },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError(executionError),
          Effect.tapError(() =>
            sql`UPDATE repository_task_members SET launch_state = 'uncertain' WHERE task_id = ${input.taskId} AND project_id = ${input.projectId}`.pipe(
              Effect.mapError(persistenceError),
            ),
          ),
        );
      yield* sql`UPDATE repository_task_members SET launch_state = 'dispatched' WHERE task_id = ${input.taskId} AND project_id = ${input.projectId}`.pipe(
        Effect.mapError(persistenceError),
      );
      yield* notifyChanged;
      return yield* get(input.taskId);
    },
    (effect, input) => locks.withLock(input.taskId, effect),
  );

  const stopTree: (
    taskId: string,
    threadId: ThreadId,
    seen: Set<ThreadId>,
  ) => Effect.Effect<void, RepositoryTaskError> = Effect.fn("RepositoryTasks.stopTree")(
    function* (taskId, threadId, seen) {
      if (seen.has(threadId)) return;
      seen.add(threadId);
      const record = yield* records(threadId);
      if (record === null) return;
      yield* threads
        .dispatch({ type: "thread.stop", commandId: command(taskId, `stop:${threadId}`), threadId })
        .pipe(Effect.mapError(executionError));
      for (const run of record.runs)
        if (run.status === "queued")
          yield* threads
            .dispatch({
              type: "queued-run.cancel",
              commandId: command(taskId, `cancel:${run.id}`),
              threadId,
              runId: run.id,
            })
            .pipe(Effect.mapError(executionError));
      for (const agent of record.subagents)
        if (agent.origin === "app_owned" && agent.childThreadId !== null)
          yield* stopTree(taskId, agent.childThreadId, seen);
    },
  );
  const stop = Effect.fn("RepositoryTasks.stop")(
    function* (taskId: string) {
      const { row, snapshot } = yield* readTask(taskId);
      if (row.state === "finished" || row.state === "stopped") return yield* get(taskId);
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE repository_tasks SET state = 'stopping' WHERE id = ${taskId}`;
            yield* sql`UPDATE repository_task_members SET delivery_state = 'disposed' WHERE task_id = ${taskId} AND delivery_state != 'delivered'`;
          }),
        )
        .pipe(Effect.mapError(persistenceError));
      const seen = new Set<ThreadId>();
      const failures: RepositoryTaskError[] = [];
      for (const threadId of [
        snapshot.coordinatorThreadId,
        ...snapshot.members.map((member) => member.threadId),
      ]) {
        yield* stopTree(taskId, threadId, seen).pipe(
          Effect.catch((error) => Effect.sync(() => failures.push(error))),
        );
      }
      if (failures.length > 0) return yield* failures[0]!;
      const view = yield* get(taskId);
      if (
        !view.graph.nodes.some((node) =>
          ["preparing", "starting", "running", "waiting", "pending", "queued"].includes(
            node.status,
          ),
        )
      )
        yield* sql`UPDATE repository_tasks SET state = 'stopped' WHERE id = ${taskId}`.pipe(
          Effect.mapError(persistenceError),
        );
      yield* notifyChanged;
      return yield* get(taskId);
    },
    (effect, taskId) => locks.withLock(taskId, effect),
  );

  /**
   * Brings the work of a member's agents back into the member workspace. Each agent worktree is
   * merged at most once; a conflict or failure writes nothing and leaves the worktree as it is.
   */
  const mergeAgentWorktrees = Effect.fn("RepositoryTasks.mergeAgentWorktrees")(function* (
    taskId: string,
    member: MemberRow,
    snap: RepositoryTaskMemberSnapshot,
    record: Records,
  ) {
    const cwd = yield* fs.realPath(memberCwd(member, snap)).pipe(Effect.mapError(executionError));
    const known = new Set(
      (yield* sql<{ source_thread_id: string }>`
        SELECT source_thread_id FROM repository_task_merges WHERE task_id = ${taskId}
      `.pipe(Effect.mapError(persistenceError))).map((row) => row.source_thread_id),
    );
    const sources: Array<{ threadId: ThreadId; worktreePath: string }> = [];
    const collect: (parent: Records) => Effect.Effect<void, RepositoryTaskError> = Effect.fn(
      "RepositoryTasks.collectAgentWorktrees",
    )(function* (parent) {
      for (const agent of parent.subagents) {
        if (agent.origin !== "app_owned" || agent.childThreadId === null) continue;
        const child = yield* records(agent.childThreadId);
        if (child === null) continue;
        if (child.thread.worktreePath !== null)
          sources.push({ threadId: child.thread.id, worktreePath: child.thread.worktreePath });
        yield* collect(child);
      }
    });
    yield* collect(record);
    for (const [ordinal, source] of sources.entries()) {
      if (known.has(source.threadId)) continue;
      const insert = (status: RepositoryTaskMerge["status"], fields: Partial<MergeRow> = {}) =>
        sql`INSERT INTO repository_task_merges (task_id, project_id, source_thread_id, worktree_path, status, base_commit, ours_tree, merged_tree, files_json, error, ordinal)
          VALUES (${taskId}, ${member.project_id}, ${source.threadId}, ${source.worktreePath}, ${status}, ${fields.base_commit ?? null}, ${fields.ours_tree ?? null}, ${fields.merged_tree ?? null}, ${fields.files_json ?? "[]"}, ${fields.error ?? null}, ${ordinal})`.pipe(
          Effect.mapError(persistenceError),
        );
      const sourceCwd = yield* fs.realPath(source.worktreePath).pipe(Effect.option);
      if (Option.isSome(sourceCwd) && sourceCwd.value === cwd) continue;
      if (Option.isNone(sourceCwd)) {
        yield* insert("failed", { error: "The agent worktree no longer exists." });
        continue;
      }
      const plan = yield* merger.plan(cwd, sourceCwd.value).pipe(Effect.result);
      if (plan._tag === "Failure") {
        yield* insert("failed", { error: plan.failure.message });
        continue;
      }
      if (plan.success.status !== "ready") {
        yield* insert(plan.success.status, {
          files_json: encodeMergeFiles(
            plan.success.status === "conflict" ? plan.success.files : [],
          ),
        });
        continue;
      }
      const ready = plan.success;
      // Recorded before the first write, so a crash mid-write surfaces as uncertain on recovery.
      yield* insert("applying", {
        base_commit: ready.baseCommit,
        ours_tree: ready.oursTree,
        merged_tree: ready.mergedTree,
        files_json: encodeMergeFiles(ready.files),
      });
      const applied = yield* merger.apply(cwd, ready).pipe(
        Effect.catch((error) =>
          merger.observe(cwd, ready.oursTree, ready.mergedTree).pipe(
            Effect.map((observation) => ({ observation, error: error.message })),
            Effect.orElseSucceed(() => ({
              observation: "diverged" as const,
              error: error.message,
            })),
          ),
        ),
        Effect.map((result) =>
          typeof result === "string" ? { observation: result, error: null } : result,
        ),
      );
      const status: RepositoryTaskMerge["status"] =
        applied.observation === "after"
          ? "applied"
          : applied.observation === "before"
            ? "failed"
            : "uncertain";
      yield* sql`UPDATE repository_task_merges SET status = ${status}, error = ${applied.error} WHERE task_id = ${taskId} AND source_thread_id = ${source.threadId}`.pipe(
        Effect.mapError(persistenceError),
      );
    }
    return yield* sql<MergeRow>`
      SELECT * FROM repository_task_merges WHERE task_id = ${taskId} AND project_id = ${member.project_id} ORDER BY ordinal
    `.pipe(Effect.mapError(persistenceError));
  });
  const mergeSummary = (merges: ReadonlyArray<MergeRow>) =>
    merges.length === 0
      ? ""
      : `\nAgent worktrees merged into this repository's workspace:\n${merges
          .map((merge) => {
            const files = decodeMergeFiles(merge.files_json);
            return `- ${merge.worktree_path}: ${merge.status}${files.length ? ` (${files.join(", ")})` : ""}${merge.error ? ` — ${merge.error}` : ""}`;
          })
          .join(
            "\n",
          )}${merges.some((merge) => !settledMerge(merge.status)) ? "\nUnmerged worktrees were left untouched; the task cannot finish until the user resolves them." : ""}\n`;

  // Finishing releases the task's repository claims, so it waits until the coordinator can no
  // longer dispatch and every launched participant's result has reached it.
  const finishIfDone = Effect.fn("RepositoryTasks.finishIfDone")(function* (
    taskId: string,
    snapshot: RepositoryTaskSnapshot,
  ) {
    const members =
      yield* sql<MemberRow>`SELECT * FROM repository_task_members WHERE task_id = ${taskId}`.pipe(
        Effect.mapError(persistenceError),
      );
    if (
      !members.every(
        (member) =>
          member.launch_state === "pending" ||
          member.launch_state === "abandoned" ||
          (member.launch_state === "dispatched" && member.delivery_state === "delivered"),
      )
    )
      return;
    const unsettledMerges = yield* sql<{ status: RepositoryTaskMerge["status"] }>`
      SELECT status FROM repository_task_merges WHERE task_id = ${taskId}
    `.pipe(Effect.mapError(persistenceError));
    if (unsettledMerges.some((merge) => !settledMerge(merge.status))) return;
    const coordinator = yield* records(snapshot.coordinatorThreadId);
    if (coordinator === null || !(yield* treeSettled(coordinator))) return;
    yield* sql`UPDATE repository_tasks SET state = 'finished' WHERE id = ${taskId} AND state = 'active'`.pipe(
      Effect.mapError(persistenceError),
    );
    yield* notifyChanged;
  });
  const reconcile = Effect.fn("RepositoryTasks.reconcile")(
    function* (taskId: string) {
      const { row, snapshot, members } = yield* readTask(taskId);
      if (row.state === "stopping") {
        const view = yield* get(taskId);
        if (
          !view.graph.nodes.some((node) =>
            ["preparing", "starting", "running", "waiting", "pending", "queued"].includes(
              node.status,
            ),
          )
        )
          yield* sql`UPDATE repository_tasks SET state = 'stopped' WHERE id = ${taskId}`.pipe(
            Effect.mapError(persistenceError),
          );
        return;
      }
      if (row.state !== "active") return;
      for (const member of members) {
        if (
          member.launch_state !== "dispatched" ||
          member.delivery_state === "delivered" ||
          member.delivery_state === "disposed"
        )
          continue;
        const record = yield* records(member.thread_id);
        if (record === null || !(yield* treeSettled(record))) continue;
        const run =
          member.result_run_id === null
            ? latestRun(record)!
            : record.runs.find((entry) => entry.id === member.result_run_id);
        if (run === undefined) return yield* fail("persistence");
        const snap = snapshot.members.find((entry) => entry.projectId === member.project_id);
        if (!snap) return yield* fail("persistence");
        const merges = yield* mergeAgentWorktrees(taskId, member, snap, record);
        const body = record.messages
          .filter(
            (entry) => entry.role === "assistant" && entry.runId === run.id && !entry.streaming,
          )
          .map((entry) => entry.text)
          .join("\n");
        yield* sql`UPDATE repository_task_members SET delivery_state = 'delivering', result_run_id = ${run.id} WHERE task_id = ${taskId} AND project_id = ${member.project_id}`.pipe(
          Effect.mapError(persistenceError),
        );
        yield* threads
          .sendToThread({
            projectId: snapshot.coordinatorWorkspaceProjectId,
            threadId: snapshot.coordinatorThreadId,
            commandId: command(taskId, `result:${member.thread_id}`),
            messageId: message(taskId, `result:${member.thread_id}`),
            senderThreadId: member.thread_id,
            mode: "queue",
            attachments: [],
            createdBy: "agent",
            creationSource: "server",
            text: `Repository task ${taskId}: project ${member.project_id} (${member.role}) finished with status ${run.status}.\nThread: ${member.thread_id}\n${mergeSummary(merges)}\n${body || "No final assistant result was recorded."}`,
          })
          .pipe(Effect.mapError(executionError));
        yield* sql`UPDATE repository_task_members SET delivery_state = 'delivered' WHERE task_id = ${taskId} AND project_id = ${member.project_id}`.pipe(
          Effect.mapError(persistenceError),
        );
        yield* notifyChanged;
      }
      yield* finishIfDone(taskId, snapshot);
    },
    (effect, taskId) =>
      locks.withLock(taskId, effect).pipe(
        Effect.retry({ times: 2 }),
        Effect.tapError(() =>
          sql`UPDATE repository_tasks SET state = 'uncertain' WHERE id = ${taskId} AND state = 'active'`.pipe(
            Effect.mapError(persistenceError),
            Effect.andThen(notifyChanged),
          ),
        ),
      ),
  );
  // A launch counts only when both its command and its first message were persisted.
  const launchAccepted = Effect.fn("RepositoryTasks.launchAccepted")(function* (
    taskId: string,
    threadId: ThreadId,
    suffix: string,
  ) {
    const receipt = yield* receipts
      .getByCommandId(command(taskId, suffix))
      .pipe(Effect.mapError(executionError));
    if (Option.isNone(receipt) || receipt.value.status !== "accepted") return false;
    const record = yield* records(threadId);
    return record?.messages.some((entry) => entry.id === message(taskId, suffix)) ?? false;
  });
  const coordinatorAccepted = (taskId: string) =>
    launchAccepted(taskId, ThreadId.make(`repository-task:${taskId}:coordinator`), "coordinator");
  const memberAccepted = (taskId: string, threadId: ThreadId) =>
    launchAccepted(taskId, threadId, `launch:${threadId}`);
  const recover = Effect.fn("RepositoryTasks.recover")(function* () {
    const rows =
      yield* sql<TaskRow>`SELECT * FROM repository_tasks WHERE state IN ('active', 'stopping', 'uncertain')`.pipe(
        Effect.mapError(persistenceError),
      );
    for (const row of rows) {
      const { members, merges } = yield* readTask(row.id);
      // A merge that was writing when the server stopped may have written some files.
      if (merges.some((merge) => merge.status === "applying"))
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE repository_task_merges SET status = 'uncertain' WHERE task_id = ${row.id} AND status = 'applying'`;
              yield* sql`UPDATE repository_tasks SET state = 'uncertain' WHERE id = ${row.id} AND state = 'active'`;
            }),
          )
          .pipe(Effect.mapError(persistenceError));
      if (!(yield* coordinatorAccepted(row.id)))
        yield* sql`UPDATE repository_tasks SET state = 'uncertain' WHERE id = ${row.id}`.pipe(
          Effect.mapError(persistenceError),
        );
      for (const member of members) {
        if (member.launch_state === "dispatching" || member.launch_state === "uncertain") {
          const accepted = yield* memberAccepted(row.id, member.thread_id);
          yield* sql`UPDATE repository_task_members SET launch_state = ${accepted ? "dispatched" : "uncertain"} WHERE task_id = ${row.id} AND project_id = ${member.project_id}`.pipe(
            Effect.mapError(persistenceError),
          );
        }
      }
      if (row.state === "stopping") yield* stop(row.id);
      else yield* reconcile(row.id);
    }
  });
  const observeUncertain = Effect.fn("RepositoryTasks.observeUncertain")(
    function* (taskId: string) {
      const { row, snapshot, members, merges } = yield* readTask(taskId);
      for (const merge of merges) {
        if (merge.status !== "uncertain") continue;
        const member = members.find((entry) => entry.project_id === merge.project_id);
        const snap = snapshot.members.find((entry) => entry.projectId === merge.project_id);
        if (!member || !snap) return yield* fail("persistence");
        // Never writes again: the files decide whether the interrupted merge landed.
        const observation =
          merge.ours_tree === null || merge.merged_tree === null
            ? "diverged"
            : yield* fs.realPath(memberCwd(member, snap)).pipe(
                Effect.flatMap((cwd) => merger.observe(cwd, merge.ours_tree!, merge.merged_tree!)),
                Effect.orElseSucceed(() => "diverged" as const),
              );
        yield* sql`UPDATE repository_task_merges SET status = ${observation === "after" ? "applied" : "failed"}, error = ${observation === "after" ? null : observation === "before" ? "The interrupted merge wrote nothing." : "The workspace no longer matches either side of the interrupted merge."} WHERE task_id = ${taskId} AND source_thread_id = ${merge.source_thread_id} AND status = 'uncertain'`.pipe(
          Effect.mapError(persistenceError),
        );
      }
      for (const member of members) {
        if (member.launch_state !== "uncertain") continue;
        const accepted = yield* memberAccepted(taskId, member.thread_id);
        yield* sql`UPDATE repository_task_members SET launch_state = ${accepted ? "dispatched" : "abandoned"} WHERE task_id = ${taskId} AND project_id = ${member.project_id} AND launch_state = 'uncertain'`.pipe(
          Effect.mapError(persistenceError),
        );
      }
      if (row.state !== "uncertain") return row.state === "active" ? "reconcile" : "none";
      // Without a started coordinator nobody can collect results, so the task can only stop.
      if (!(yield* coordinatorAccepted(taskId))) return "stop";
      yield* sql`UPDATE repository_tasks SET state = 'active' WHERE id = ${taskId} AND state = 'uncertain'`.pipe(
        Effect.mapError(persistenceError),
      );
      return "reconcile";
    },
    (effect, taskId) => locks.withLock(taskId, effect),
  );
  const acknowledge = Effect.fn("RepositoryTasks.acknowledge")(function* (taskId: string) {
    const next = yield* observeUncertain(taskId);
    if (next === "stop") yield* stop(taskId);
    else if (next === "reconcile") yield* reconcile(taskId);
    yield* notifyChanged;
    return yield* get(taskId);
  });
  const setArchived = Effect.fn("RepositoryTasks.setArchived")(
    function* (taskId: string, archived: boolean) {
      const { row } = yield* readTask(taskId);
      // Archiving hides a task, so one that may still run or claim repositories stays visible.
      if (archived && row.state !== "finished" && row.state !== "stopped")
        return yield* fail("conflict");
      const archivedAt = archived ? DateTime.formatIso(yield* DateTime.now) : null;
      yield* sql`UPDATE repository_tasks SET archived_at = ${archivedAt} WHERE id = ${taskId} AND (archived_at IS NULL) = ${archived ? 1 : 0}`.pipe(
        Effect.mapError(persistenceError),
      );
      yield* notifyChanged;
      return yield* get(taskId);
    },
    (effect, taskId) => locks.withLock(taskId, effect),
  );
  const listTasks = Effect.fn("RepositoryTasks.listTasks")(function* (input: {
    readonly archived: boolean;
  }) {
    const rows = yield* sql<{ id: string }>`
      SELECT id FROM repository_tasks WHERE (archived_at IS NOT NULL) = ${input.archived ? 1 : 0}
      ORDER BY rowid DESC LIMIT 100
    `.pipe(Effect.mapError(persistenceError));
    return yield* Effect.forEach(rows, (row) => get(row.id));
  });
  const taskIdsForThread = Effect.fn("RepositoryTasks.taskIdsForThread")(function* (
    threadId: ThreadId,
  ) {
    const rows = yield* sql<{
      task_id: string;
    }>`SELECT task_id FROM repository_task_members WHERE thread_id = ${threadId}`.pipe(
      Effect.mapError(persistenceError),
    );
    if (rows.length > 0) return rows.map((row) => row.task_id);
    const coordinators = yield* sql<{
      id: string;
    }>`SELECT id FROM repository_tasks WHERE coordinator_thread_id = ${threadId}`.pipe(
      Effect.mapError(persistenceError),
    );
    if (coordinators.length > 0) return coordinators.map((row) => row.id);
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(executionError));
    if (shell?.lineage.relationshipToParent === "subagent") {
      const roots = yield* sql<{
        task_id: string;
      }>`SELECT task_id FROM repository_task_members WHERE thread_id = ${shell.lineage.rootThreadId}`.pipe(
        Effect.mapError(persistenceError),
      );
      if (roots.length > 0) return roots.map((row) => row.task_id);
      const coordinators = yield* sql<{
        id: string;
      }>`SELECT id FROM repository_tasks WHERE coordinator_thread_id = ${shell.lineage.rootThreadId}`.pipe(
        Effect.mapError(persistenceError),
      );
      return coordinators.map((row) => row.id);
    }
    return [];
  });
  const subscribe = (taskId: string) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(get(taskId)),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => get(taskId))),
        );
      }),
    );
  return {
    subscribe,
    notifyChanged,
    listGroups,
    upsertGroup,
    deleteGroup,
    listTasks,
    create,
    get,
    dispatch,
    stop,
    acknowledge,
    archive: (taskId) => setArchived(taskId, true),
    unarchive: (taskId) => setArchived(taskId, false),
    reconcile,
    recover: recover(),
    taskIdsForThread,
  } satisfies RepositoryTasks["Service"];
});
export const layer = Layer.effect(RepositoryTasks, make);
