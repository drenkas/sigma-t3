import {
  RepositoryTaskError,
  RepositoryTaskSnapshot,
  isProviderAvailable,
  resolveProjectProviderInstanceEnabled,
  type OrchestrationV2AppThread,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import { pathsOverlap } from "./paths.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ProjectService from "../project/ProjectService.ts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

const decodeSnapshot = Schema.decodeEffect(Schema.fromJsonString(RepositoryTaskSnapshot));

type Delegation = Extract<OrchestrationV2ServerCommand, { type: "delegated_task.request" }>;
type Thread = Pick<OrchestrationV2AppThread, "id" | "projectId" | "lineage" | "worktreePath">;
const denied = () => new RepositoryTaskError({ reason: "conflict" });
const persistence = (cause: unknown) => new RepositoryTaskError({ reason: "persistence", cause });

export class RepositoryTaskPolicy extends Context.Service<
  RepositoryTaskPolicy,
  {
    readonly prepareDelegation: (
      thread: Thread,
      input: OrchestratorMcpDelegateTaskInput,
    ) => Effect.Effect<OrchestratorMcpDelegateTaskInput, RepositoryTaskError>;
    readonly assertStandaloneAllowed: (thread: Thread) => Effect.Effect<void, RepositoryTaskError>;
    readonly prepareNativeDelegation: (
      thread: Thread,
      command: Delegation,
    ) => Effect.Effect<Delegation, RepositoryTaskError>;
    readonly assertWorkspaceIdentity: (
      thread: Thread,
      workspaceRoot?: string,
    ) => Effect.Effect<void, RepositoryTaskError>;
    readonly assertMayStart: (
      thread: Thread,
      runtimeCwd?: string | null,
    ) => Effect.Effect<void, RepositoryTaskError>;
  }
>()("t3/repositoryTasks/RepositoryTaskPolicy") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const adapters = yield* ProviderAdapters.ProviderAdapterRegistryV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const projects = yield* ProjectService.ProjectService;
  const owner = Effect.fn("RepositoryTaskPolicy.owner")(function* (thread: Thread) {
    const rows = yield* sql<{
      id: string;
      state: string;
      snapshot_json: string;
      role: string | null;
      thread_id: string | null;
      prepared_path: string | null;
    }>`
      SELECT task.id, task.state, task.snapshot_json, member.role, member.thread_id, member.prepared_path
      FROM repository_tasks AS task LEFT JOIN repository_task_members AS member ON member.task_id = task.id
      WHERE task.coordinator_thread_id IN (${thread.id}, ${thread.lineage.rootThreadId})
         OR member.thread_id IN (${thread.id}, ${thread.lineage.rootThreadId}) LIMIT 1
    `.pipe(Effect.mapError(persistence));
    if (!rows[0]) return null;
    const row = rows[0];
    // A finished task no longer owns its threads; they continue as ordinary threads.
    if (row.state === "finished") return null;
    const snapshot = yield* decodeSnapshot(row.snapshot_json).pipe(Effect.mapError(persistence));
    return { ...row, snapshot };
  });
  const assertStandaloneAllowed = Effect.fn("RepositoryTaskPolicy.assertStandaloneAllowed")(
    function* (thread: Thread) {
      if ((yield* owner(thread)) !== null) return yield* denied();
    },
  );
  const assertWorkspaceIdentity = Effect.fn("RepositoryTaskPolicy.assertWorkspaceIdentity")(
    function* (thread: Thread, workspaceRoot?: string) {
      const task = yield* owner(thread);
      if (task === null) return;
      if (task.state !== "active") return yield* denied();
      const member = task.snapshot.members.find(
        (entry) => entry.threadId === thread.id || entry.threadId === thread.lineage.rootThreadId,
      );
      if (!member) return;
      const source =
        workspaceRoot === undefined
          ? yield* projects.getById(thread.projectId).pipe(
              Effect.mapError(persistence),
              Effect.flatMap((entry) =>
                Option.isSome(entry) ? Effect.succeed(entry.value.workspaceRoot) : denied(),
              ),
            )
          : workspaceRoot;
      const canonical = yield* fs.realPath(source).pipe(Effect.mapError(persistence));
      if (canonical !== member.workspaceRoot) return yield* denied();
    },
  );
  const assertMayStart = Effect.fn("RepositoryTaskPolicy.assertMayStart")(function* (
    thread: Thread,
    runtimeCwd?: string | null,
  ) {
    const task = yield* owner(thread);
    if (task !== null && task.state !== "active") return yield* denied();
    // Check every provider start, including unrelated native threads started after task creation.
    const source = yield* projects.getById(thread.projectId).pipe(Effect.mapError(persistence));
    if (Option.isNone(source)) return yield* denied();
    yield* assertWorkspaceIdentity(thread, source.value.workspaceRoot);
    const cwd = yield* fs
      .realPath(runtimeCwd ?? thread.worktreePath ?? source.value.workspaceRoot)
      .pipe(Effect.mapError(persistence));
    if (task !== null) {
      if (thread.id === task.thread_id) {
        const member = task.snapshot.members.find((entry) => entry.threadId === thread.id);
        const expected =
          task.prepared_path ??
          (member?.workspaceStrategy.type === "root"
            ? member.workspaceRoot
            : member?.workspaceStrategy.type === "existing_worktree"
              ? member.workspaceStrategy.worktreePath
              : null);
        if (expected === null || cwd !== expected) return yield* denied();
      } else if (
        thread.worktreePath === null ||
        cwd !== (yield* fs.realPath(thread.worktreePath).pipe(Effect.mapError(persistence)))
      )
        return yield* denied();
    }
    const claims = yield* sql<{
      id: string;
      snapshot_json: string;
      project_id: string;
      prepared_path: string | null;
    }>`
      SELECT task.id, task.snapshot_json, member.project_id, member.prepared_path
      FROM repository_tasks AS task JOIN repository_task_members AS member ON member.task_id = task.id
      WHERE task.state IN ('active', 'stopping', 'uncertain') AND member.delivery_state != 'delivered'
    `.pipe(Effect.mapError(persistence));
    for (const claim of claims) {
      if (claim.id === task?.id) continue;
      const snapshot = yield* decodeSnapshot(claim.snapshot_json).pipe(
        Effect.mapError(persistence),
      );
      const member = snapshot.members.find((entry) => entry.projectId === claim.project_id);
      if (!member) return yield* denied();
      const claimedPath =
        claim.prepared_path ??
        (member.workspaceStrategy.type === "existing_worktree"
          ? member.workspaceStrategy.worktreePath
          : member.workspaceStrategy.type === "root"
            ? member.workspaceRoot
            : null);
      if (claimedPath !== null && pathsOverlap(cwd, claimedPath)) return yield* denied();
    }
  });
  const prepareDelegation = Effect.fn("RepositoryTaskPolicy.prepareDelegation")(function* (
    thread: Thread,
    input: OrchestratorMcpDelegateTaskInput,
  ) {
    const task = yield* owner(thread);
    if (task === null) return input;
    if (
      task.state !== "active" ||
      task.snapshot.coordinatorThreadId === thread.id ||
      task.snapshot.coordinatorThreadId === thread.lineage.rootThreadId
    )
      return yield* denied();
    const role = task.snapshot.roles.find(
      (candidate) => candidate.role === (input.role ?? task.role),
    );
    if (!role || input.isolation === "shared") return yield* denied();
    const selected = role.modelSelection;
    const provider = (yield* registry.getProviders).find(
      (candidate) => candidate.instanceId === selected.instanceId,
    );
    const model = provider?.models.find((candidate) => candidate.slug === selected.model);
    if (
      !provider ||
      !model ||
      !provider.enabled ||
      !provider.installed ||
      !isProviderAvailable(provider) ||
      provider.status === "disabled" ||
      provider.status === "error" ||
      provider.auth.status === "unauthenticated" ||
      !(yield* adapters.list()).includes(selected.instanceId) ||
      !resolveProjectProviderInstanceEnabled(
        yield* settings.getSettings.pipe(Effect.mapError(persistence)),
        thread.projectId,
        selected.instanceId,
      )
    )
      return yield* denied();
    const seen = new Set<string>();
    for (const option of selected.options ?? []) {
      const descriptor = model.capabilities?.optionDescriptors?.find(
        (entry) => entry.id === option.id,
      );
      if (
        !descriptor ||
        seen.has(option.id) ||
        (descriptor.type === "boolean"
          ? typeof option.value !== "boolean"
          : !descriptor.options.some((entry) => entry.id === option.value))
      )
        return yield* denied();
      seen.add(option.id);
    }
    if (
      (input.target?.providerInstanceId !== undefined &&
        input.target.providerInstanceId !== selected.instanceId) ||
      (input.target?.model !== undefined && input.target.model !== selected.model) ||
      (input.target?.driverKind !== undefined && input.target.driverKind !== provider.driver) ||
      (input.target?.options !== undefined &&
        (input.target.options.length !== (selected.options?.length ?? 0) ||
          input.target.options.some(
            (option) =>
              !selected.options?.some(
                (entry) => entry.id === option.id && entry.value === option.value,
              ),
          )))
    )
      return yield* denied();
    return {
      ...input,
      role: role.role,
      target: {
        providerInstanceId: selected.instanceId,
        model: selected.model,
        options: selected.options ?? [],
      },
      isolation: "worktree" as const,
    };
  });
  const prepareNativeDelegation = Effect.fn("RepositoryTaskPolicy.prepareNativeDelegation")(
    function* (thread: Thread, command: Delegation) {
      const task = yield* owner(thread);
      if (task === null) return command;
      const role = task.snapshot.roles.find((entry) => entry.role === (command.role ?? task.role));
      if (!role) return yield* denied();
      if (command.workspaceStrategy?.type !== "worktree") return yield* denied();
      const prepared = yield* prepareDelegation(thread, {
        task: command.task,
        role: role.role,
        target: {
          providerInstanceId: command.modelSelection.instanceId,
          model: command.modelSelection.model,
          options: command.modelSelection.options ?? [],
        },
        isolation: "worktree",
      });
      return { ...command, ...(prepared.role === undefined ? {} : { role: prepared.role }) };
    },
  );
  return {
    prepareDelegation,
    prepareNativeDelegation,
    assertStandaloneAllowed,
    assertMayStart,
    assertWorkspaceIdentity,
  };
});
export const layer = Layer.effect(RepositoryTaskPolicy, make);
